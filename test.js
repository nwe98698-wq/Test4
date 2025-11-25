const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const moment = require('moment');

// Bot configuration
const BOT_TOKEN = "8225668512:AAGx4b11DU_1uO0YP641kGjgYhZZx0Iz5yg";

// Channel configuration
const SIGNAL_CHANNEL_USERNAME = "@sakuna_vip";
const CHANNEL_USERNAME = "@sakuna_vip";
const CHANNEL_LINK = "https://t.me/sakuna_vip";

// API endpoint
const API_ENDPOINT = "https://api.bigwinqaz.com/api/webapi/";

// Database setup
const DB_NAME = "777_auto_bot.db";

// Auto Signal Configuration
const AUTO_SIGNAL_ENABLED = true;
const SIGNAL_INTERVAL = 60 * 1000; // 60 seconds in milliseconds

// Bet Sequence for Loss
const BET_SEQUENCE = [10, 30, 70, 160, 320, 760, 1600, 3200, 7600, 16000, 32000, 76000];

// Global storage for tracking current issues
const currentIssues = {
    '777': { issue: '', bet_type: '', amount: 0, step: 0 }
};

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Database functions
function initDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_NAME);
        
        db.serialize(() => {
            // Create users table
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    user_id INTEGER PRIMARY KEY,
                    phone TEXT,
                    password TEXT,
                    platform TEXT DEFAULT '777',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create user_settings table
            db.run(`
                CREATE TABLE IF NOT EXISTS user_settings (
                    user_id INTEGER PRIMARY KEY,
                    bet_amount INTEGER DEFAULT 100,
                    auto_login BOOLEAN DEFAULT 1,
                    platform TEXT DEFAULT '777',
                    language TEXT DEFAULT 'english',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create signal_history table
            db.run(`
                CREATE TABLE IF NOT EXISTS signal_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT,
                    issue TEXT,
                    bet_type TEXT,
                    amount INTEGER,
                    result TEXT,
                    profit_loss INTEGER,
                    current_step INTEGER,
                    signal_text TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create bet_sequence table
            db.run(`
                CREATE TABLE IF NOT EXISTS bet_sequence (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT,
                    current_step INTEGER DEFAULT 0,
                    last_result TEXT,
                    total_profit INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) {
                    console.error("Database initialization error:", err);
                    reject(err);
                } else {
                    console.log("Database initialized successfully");
                    resolve();
                }
            });
        });
        
        db.close();
    });
}

function migrateDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_NAME);
        
        // FIX: Use db.all() instead of db.get() for PRAGMA table_info
        db.all("PRAGMA table_info(user_settings)", (err, rows) => {
            if (err) {
                console.error("Migration error:", err);
                reject(err);
                return;
            }
            
            // Now rows is an array, so we can use map
            const columns = rows.map(row => row.name);
            if (!columns.includes('language')) {
                console.log("🔧 Migrating database: Adding language column...");
                db.run('ALTER TABLE user_settings ADD COLUMN language TEXT DEFAULT "english"', (err) => {
                    if (err) {
                        console.error("Migration error:", err);
                        reject(err);
                    } else {
                        console.log("✅ Database migration completed: language column added");
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
        
        db.close();
    });
}

function saveSignalHistory(platform, issue, betType, amount, result, profitLoss, currentStep, signalText) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_NAME);
        
        db.run(`
            INSERT INTO signal_history (platform, issue, bet_type, amount, result, profit_loss, current_step, signal_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [platform, issue, betType, amount, result, profitLoss, currentStep, signalText], function(err) {
            if (err) {
                console.error("Error saving signal history:", err);
                reject(err);
            } else {
                resolve(true);
            }
        });
        
        db.close();
    });
}

function getPlatformSequence(platform) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_NAME);
        
        db.get(`
            SELECT current_step, last_result, total_profit FROM bet_sequence 
            WHERE platform = ? ORDER BY created_at DESC LIMIT 1
        `, [platform], (err, row) => {
            if (err) {
                console.error("Error getting platform sequence:", err);
                reject(err);
            } else {
                if (row) {
                    resolve({
                        current_step: row.current_step,
                        last_result: row.last_result,
                        total_profit: row.total_profit
                    });
                } else {
                    resolve({ current_step: 0, last_result: null, total_profit: 0 });
                }
            }
        });
        
        db.close();
    });
}

function updatePlatformSequence(platform, currentStep, lastResult, totalProfit) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_NAME);
        
        db.run(`
            INSERT INTO bet_sequence (platform, current_step, last_result, total_profit)
            VALUES (?, ?, ?, ?)
        `, [platform, currentStep, lastResult, totalProfit], function(err) {
            if (err) {
                console.error("Error updating platform sequence:", err);
                reject(err);
            } else {
                resolve(true);
            }
        });
        
        db.close();
    });
}

// Lottery API class
class LotteryBot {
    constructor(platform = '777') {
        this.platform = platform;
        this.baseUrl = API_ENDPOINT;
        
        this.headers = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://www.bigwinqaz.com",
            "Referer": "https://www.bigwinqaz.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        };
    }
    
    signMd5(dataDict) {
        const signData = { ...dataDict };
        delete signData.signature;
        delete signData.timestamp;
        
        const sortedKeys = Object.keys(signData).sort();
        const sortedData = {};
        sortedKeys.forEach(key => {
            sortedData[key] = signData[key];
        });
        
        const hashString = JSON.stringify(sortedData).replace(/\s/g, '');
        const md5Hash = crypto.createHash('md5').update(hashString).digest('hex');
        return md5Hash.toUpperCase();
    }
    
    randomKey() {
        const xxxx = "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx";
        let result = "";
        
        for (let char of xxxx) {
            if (char === 'x') {
                result += '0123456789abcdef'[Math.floor(Math.random() * 16)];
            } else if (char === 'y') {
                result += '89a'[Math.floor(Math.random() * 3)];
            } else {
                result += char;
            }
        }
        return result;
    }
    
    async getCurrentIssue() {
        try {
            const body = {
                "typeId": 1,
                "language": 0,
                "random": "b05034ba4a2642009350ee863f29e2e9",
                "timestamp": Math.floor(Date.now() / 1000)
            };
            body.signature = this.signMd5(body);
            
            const response = await axios.post(
                `${this.baseUrl}GetGameIssue`,
                body,
                { 
                    headers: this.headers,
                    timeout: 10000 
                }
            );
            
            if (response.status === 200) {
                const result = response.data;
                if (result.msgCode === 0) {
                    return result.data?.issueNumber || '';
                }
            }
            return "";
        } catch (error) {
            console.error(`Get issue error for ${this.platform}:`, error);
            return "";
        }
    }
    
    async getRecentResults(count = 5) {
        try {
            const body = {
                "pageNo": 1,
                "pageSize": count,
                "language": 0,
                "typeId": 1,
                "random": "6DEB0766860C42151A193692ED16D65A",
                "timestamp": Math.floor(Date.now() / 1000)
            };
            body.signature = this.signMd5(body);
            
            const response = await axios.post(
                `${this.baseUrl}GetNoaverageEmerdList`,
                body,
                { 
                    headers: this.headers,
                    timeout: 10000 
                }
            );
            
            if (response.status === 200) {
                const result = response.data;
                if (result.msgCode === 0) {
                    const dataStr = JSON.stringify(response.data);
                    const startIdx = dataStr.indexOf('[');
                    const endIdx = dataStr.indexOf(']') + 1;
                    
                    if (startIdx !== -1 && endIdx !== -1) {
                        const resultsJson = dataStr.substring(startIdx, endIdx);
                        const results = JSON.parse(resultsJson);
                        return results;
                    }
                }
            }
            return [];
        } catch (error) {
            console.error(`Get results error for ${this.platform}:`, error);
            return [];
        }
    }
}

// Analysis functions
function analyzeResults(results) {
    if (!results || results.length < 2) {
        return { bet_type: ['BIG', 'SMALL'][Math.floor(Math.random() * 2)], confidence: 'LOW' };
    }
    
    const lastResult = results[0];
    const secondLast = results[1];
    
    const number = String(lastResult.number || '');
    const prevNumber = String(secondLast.number || '');
    
    const lastWasSmall = ['0','1','2','3','4'].includes(number);
    const lastWasBig = !lastWasSmall;
    const prevWasSmall = ['0','1','2','3','4'].includes(prevNumber);
    const prevWasBig = !prevWasSmall;
    
    if (lastWasBig && prevWasBig) {
        return { bet_type: 'BIG', confidence: 'HIGH' };
    } else if (lastWasSmall && prevWasSmall) {
        return { bet_type: 'SMALL', confidence: 'HIGH' };
    } else if (lastWasBig && prevWasSmall) {
        return { bet_type: 'SMALL', confidence: 'MEDIUM' };
    } else {
        return { bet_type: 'BIG', confidence: 'MEDIUM' };
    }
}

function calculateProfitLoss(betType, resultNumber, betAmount) {
    resultNumber = String(resultNumber);
    
    if (betType === 'BIG') {
        if (['5','6','7','8','9'].includes(resultNumber)) {
            const profit = Math.floor(betAmount * 0.96);
            return ['WIN', profit];
        } else {
            return ['LOSS', -betAmount];
        }
    } else if (betType === 'SMALL') {
        if (['0','1','2','3','4'].includes(resultNumber)) {
            const profit = Math.floor(betAmount * 0.96);
            return ['WIN', profit];
        } else {
            return ['LOSS', -betAmount];
        }
    } else {
        return ['UNKNOWN', 0];
    }
}

function getNextBetAmount(currentStep) {
    if (currentStep < BET_SEQUENCE.length) {
        return BET_SEQUENCE[currentStep] * 100;
    } else {
        return BET_SEQUENCE[BET_SEQUENCE.length - 1] * 100;
    }
}

function generateSignalText(platform, issue, betType, amount, currentStep, totalProfit, confidence) {
    return `

💡 Issue: ${issue}
🎲 Bet: ${betType}
💰 Amount: ${amount.toLocaleString()} K

    `;
}

function generateInstantResultText(platform, issue, betType, amount, result, profitLoss, currentStep, totalProfit, resultNumber) {
    if (result === 'WIN') {
        return `
🟢 BET RESULT UPDATE 

💰 Total Profit: ${totalProfit.toLocaleString()} K 🏆🏆🏆

    `;
    } else {
        const nextStep = currentStep + 1;
        const nextAmount = getNextBetAmount(nextStep);
        return `
🔴 BET RESULT UPDATE 

💰 Total Profit: ${totalProfit.toLocaleString()} K 🏆🏆🏆

    `;
    }
}

// Signal functions
async function sendSignalForPlatform(platform) {
    try {
        const lotteryApi = new LotteryBot(platform);
        
        const currentIssue = await lotteryApi.getCurrentIssue();
        const recentResults = await lotteryApi.getRecentResults(3);
        
        if (!currentIssue) {
            console.error(`No current issue for ${platform}`);
            return false;
        }
        
        if (!recentResults.length) {
            console.error(`No recent results for ${platform}`);
            return false;
        }
        
        const sequenceData = await getPlatformSequence(platform);
        const currentStep = sequenceData.current_step;
        const totalProfit = sequenceData.total_profit;
        
        const analysis = analyzeResults(recentResults);
        const betType = analysis.bet_type;
        const confidence = analysis.confidence;
        
        const betAmount = getNextBetAmount(currentStep);
        
        currentIssues[platform] = {
            issue: currentIssue,
            bet_type: betType,
            amount: betAmount,
            step: currentStep
        };
        
        const signalText = generateSignalText(platform, currentIssue, betType, betAmount, currentStep, totalProfit, confidence);
        
        await bot.sendMessage(SIGNAL_CHANNEL_USERNAME, signalText);
        
        console.log(`777 Signal sent: ${betType} ${betAmount}K (Step ${currentStep + 1})`);
        return true;
        
    } catch (error) {
        console.error(`Error sending signal for ${platform}:`, error);
        return false;
    }
}

async function process777Result(platform, issueData, resultIssue, resultNumber) {
    try {
        const currentIssue = issueData.issue;
        const betType = issueData.bet_type;
        const betAmount = issueData.amount;
        const currentStep = issueData.step;
        
        const sequenceData = await getPlatformSequence(platform);
        const totalProfit = sequenceData.total_profit;
        
        const [result, profitLoss] = calculateProfitLoss(betType, resultNumber, betAmount);
        
        let newStep, newTotalProfit;
        if (result === 'WIN') {
            newStep = 0;
            newTotalProfit = totalProfit + profitLoss;
        } else {
            newStep = currentStep + 1;
            if (newStep >= BET_SEQUENCE.length) {
                newStep = BET_SEQUENCE.length - 1;
            }
            newTotalProfit = totalProfit + profitLoss;
        }
        
        await updatePlatformSequence(platform, newStep, result, newTotalProfit);
        
        const resultText = generateInstantResultText(
            platform, currentIssue, betType, betAmount, result, 
            profitLoss, currentStep, newTotalProfit, resultNumber
        );
        
        await bot.sendMessage(SIGNAL_CHANNEL_USERNAME, resultText);
        
        await saveSignalHistory(
            platform, currentIssue, betType, betAmount, result, 
            profitLoss, currentStep, resultText
        );
        
        currentIssues[platform] = { issue: '', bet_type: '', amount: 0, step: 0 };
        
        console.log(`777 Result processed: ${result} (Profit: ${profitLoss}, New Step: ${newStep})`);
        
        // Send next signal after 2 seconds
        setTimeout(() => {
            sendSignalForPlatform(platform);
        }, 2000);
        
        return true;
        
    } catch (error) {
        console.error(`Error processing 777 result:`, error);
        return false;
    }
}

async function check777ResultsContinuously() {
    console.log("Starting continuous result checking for 777");
    
    while (true) {
        try {
            const platform = '777';
            const currentIssueData = currentIssues[platform];
            
            if (currentIssueData.issue) {
                const lotteryBot = new LotteryBot(platform);
                const newResults = await lotteryBot.getRecentResults(2);
                
                if (newResults && newResults.length > 0) {
                    const latestResult = newResults[0];
                    const resultIssue = latestResult.issueNumber || '';
                    const resultNumber = String(latestResult.number || '');
                    
                    if (resultIssue === currentIssueData.issue) {
                        await process777Result(platform, currentIssueData, resultIssue, resultNumber);
                    } else if (newResults.length > 1) {
                        const secondResult = newResults[1];
                        const secondIssue = secondResult.issueNumber || '';
                        const secondNumber = String(secondResult.number || '');
                        
                        if (secondIssue === currentIssueData.issue) {
                            await process777Result(platform, currentIssueData, secondIssue, secondNumber);
                        }
                    }
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
        } catch (error) {
            console.error("Error in continuous 777 result check:", error);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function startAutoSignal() {
    console.log("777 Auto signal service started");
    
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Start continuous result checking
    check777ResultsContinuously().catch(console.error);
    
    // Send first signal
    await sendSignalForPlatform('777');
    
    // Main signal loop
    while (true) {
        try {
            const startTime = new Date();
            console.log(`Starting new 777 signal cycle at ${moment().format('HH:mm:ss')}`);
            
            const platform = '777';
            const currentIssueData = currentIssues[platform];
            
            if (!currentIssueData.issue) {
                const signalSent = await sendSignalForPlatform(platform);
                
                if (signalSent) {
                    console.log("777 signal sent successfully");
                } else {
                    console.error("Failed to send 777 signal");
                }
            }
            
            const cycleDuration = new Date() - startTime;
            const waitTime = Math.max(0, SIGNAL_INTERVAL - cycleDuration);
            
            if (waitTime > 0) {
                console.log(`Waiting ${(waitTime / 1000).toFixed(1)} seconds for next 777 signal`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            } else {
                console.log("Starting next 777 signal immediately");
            }
            
        } catch (error) {
            console.error("Error in 777 signal cycle:", error);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
}

// Telegram bot handlers
function getJoinChannelKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "📢 Join Our Channel", url: CHANNEL_LINK }],
            [{ text: "✅ I've Joined", callback_data: "check_join" }]
        ]
    };
}

async function checkChannelMembership(userId) {
    try {
        const chatMember = await bot.getChatMember(CHANNEL_USERNAME, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        console.error("Error checking channel membership:", error);
        return true;
    }
}

// Bot command handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const hasJoined = await checkChannelMembership(userId);
    
    if (!hasJoined) {
        const welcomeText = `
🎰 Welcome to 777 Auto Signal Bot 🎯

Dear ${msg.from.first_name},

To use this bot, you need to join our official channel first for VIP signals.

Why join our channel?
• 📊 Get real-time 777 LOTTERY signals
• 💡 Professional analysis  
• 🔔 Instant result updates
• 🎯 High accuracy predictions

Please join our channel below and then click ✅ I've Joined to verify.
        `;
        
        await bot.sendMessage(chatId, welcomeText, {
            reply_markup: getJoinChannelKeyboard()
        });
        return;
    }
    
    const welcomeText = `
🎰 777 Auto Signal Bot 🎯

Welcome ${msg.from.first_name}!

🤖 777 Automatic Signal Features:
• 📊 777 LOTTERY Signals Only
• ⏰ Instant WinLoss + Next Issue
• 📈 Real Win/Loss Results
• 🔢 Smart Bet Sequence
• 🎲 BIG/SMALL Only Strategy
• ⚡ Instant Result Checking

📢 Channel: @sakuna_vip

🚀 Current Mode: 777 platform signals with instant WinLoss and immediate next issue!
    `;
    
    await bot.sendMessage(chatId, welcomeText);
    
    // Start auto signal service
    startAutoSignal().catch(console.error);
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const platform = '777';
        const sequenceData = await getPlatformSequence(platform);
        const currentStep = sequenceData.current_step;
        const totalProfit = sequenceData.total_profit;
        const lastResult = sequenceData.last_result || 'N/A';
        
        const currentIssue = currentIssues[platform].issue;
        const currentBet = currentIssues[platform].bet_type;
        
        let statusText = `
📊 777 LOTTERY Bot Status

🎯 Current Step: ${currentStep + 1}
📈 Last Result: ${lastResult}
💰 Total Profit: ${totalProfit.toLocaleString()} K
        `;
        
        if (currentIssue) {
            statusText += `
📋 Current Issue: ${currentIssue}
🎲 Current Bet: ${currentBet}
            `;
        }
        
        statusText += `
⏰ Signal Mode: Instant WinLoss + Next Issue
🔢 Bet Sequence: ${BET_SEQUENCE.join(', ')}
⚡ Result Mode: Continuous Checking
🕒 Last Update: ${moment().format('HH:mm:ss')}
        `;
        
        await bot.sendMessage(chatId, statusText);
        
    } catch (error) {
        console.error("Error in status command:", error);
        await bot.sendMessage(chatId, "❌ Error getting status.");
    }
});

bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const platform = '777';
        
        await updatePlatformSequence(platform, 0, 'RESET', 0);
        currentIssues[platform] = { issue: '', bet_type: '', amount: 0, step: 0 };
        
        await bot.sendMessage(
            chatId,
            "✅ 777 Platform reset to Step 1!\n\nSequence has been reset and total profit cleared."
        );
        
    } catch (error) {
        console.error("Error in reset command:", error);
        await bot.sendMessage(chatId, "❌ Error resetting platform.");
    }
});

bot.onText(/\/force/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        await bot.sendMessage(chatId, "🔄 Forcing immediate 777 signal...");
        
        const platform = '777';
        const success = await sendSignalForPlatform(platform);
        
        if (success) {
            await bot.sendMessage(chatId, "✅ 777 signal sent successfully!");
        } else {
            await bot.sendMessage(chatId, "❌ Failed to send 777 signal.");
        }
        
    } catch (error) {
        console.error("Error in force signal command:", error);
        await bot.sendMessage(chatId, "❌ Error sending signal.");
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;
    
    if (callbackQuery.data === "check_join") {
        const hasJoined = await checkChannelMembership(userId);
        
        if (hasJoined) {
            await bot.editMessageText(
                "✅ Thank you for joining our channel! You can now use the bot.\n\nPress /start to begin.",
                {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    reply_markup: { inline_keyboard: [] }
                }
            );
        } else {
            await bot.editMessageText(
                "❌ You haven't joined our channel yet. Please join the channel first to use the bot.",
                {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    reply_markup: getJoinChannelKeyboard()
                }
            );
        }
    }
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (text === "📊 Status") {
        // Handle status via existing command
        await bot.sendMessage(chatId, "📊 Getting status...");
        const statusMsg = { ...msg, text: '/status' };
        bot.emit('text', statusMsg);
    } else if (text === "🔄 Reset") {
        await bot.sendMessage(chatId, "🔄 Resetting...");
        const resetMsg = { ...msg, text: '/reset' };
        bot.emit('text', resetMsg);
    } else if (text === "🚀 Force Signal") {
        await bot.sendMessage(chatId, "🚀 Forcing signal...");
        const forceMsg = { ...msg, text: '/force' };
        bot.emit('text', forceMsg);
    } else {
        await bot.sendMessage(
            chatId,
            "Please use /start to begin or check the status with 📊 Status"
        );
    }
});

// Error handling
bot.on('error', (error) => {
    console.error('Telegram Bot Error:', error);
});

// Initialize and start bot
async function main() {
    if (BOT_TOKEN === "YOUR_BOT_TOKEN_HERE") {
        console.log("❌ Please set your BOT_TOKEN in the code!");
        return;
    }
    
    try {
        await initDatabase();
        await migrateDatabase();
        
        console.log("🤖 777 Auto Signal Bot is running...");
        console.log("📢 Auto Signal System: ENABLED");
        console.log(`📊 Signal Channel: ${SIGNAL_CHANNEL_USERNAME}`);
        console.log("🎯 Platform: 777 LOTTERY ONLY");
        console.log("🎲 Bet Type: BIG/SMALL Only");
        console.log("🔢 Bet Sequence: " + BET_SEQUENCE.join(','));
        console.log("⚡ Result Mode: INSTANT WINLOSS + NEXT ISSUE");
        console.log("🔄 Win Strategy: Reset to Step 1");
        console.log("📈 Loss Strategy: Progress through sequence");
        console.log("💰 Real Profit/Loss Tracking");
        console.log("⏹️  Press Ctrl+C to stop.");
        
    } catch (error) {
        console.error("Failed to start bot:", error);
    }
}

// Start the application
main().catch(console.error);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Bot is shutting down...');
    bot.stopPolling();
    process.exit(0);
});