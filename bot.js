/**
 * ============================================================
 * WhatsApp AI Bot — Powered by Ollama (phi3:mini)
 * Author  : Alee Agha
 * Version : 2.0.0
 * ============================================================
 *
 * HOW IT WORKS:
 *   /ai      → Start AI conversation for this user
 *   \ai      → End AI conversation for this user
 *   /help    → Show command list
 *   /time    → Show current Pakistan time
 *   /joke    → Send a random joke
 *   /clear   → Clear your conversation memory
 *
 * ADMIN ONLY (923012596880):
 *   /bot on        → Enable bot globally
 *   /bot off       → Disable bot globally
 *   /stats         → Show active users, memory usage
 *   /broadcast msg → Send a message to all active users
 *   /clearall      → Clear all user memories
 */

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode               = require('qrcode-terminal');
const axios                = require('axios');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    adminNumber : '923012596880@c.us',
    ollama      : {
        url   : 'http://127.0.0.1:11434/api/generate',
        model : 'phi3:mini',
        options: {
            temperature : 0.7,
            top_p       : 0.9,
            num_predict : 2048
        },
        timeout: 120_000
    },
    bot: {
        name       : 'AI Assistant',
        maxHistory : 20,   // messages kept per user
    }
};

// ============================================================
// RUNTIME STATE
// ============================================================
let   botEnabled  = true;
const aiSessions  = new Map();   // sender → true/false  (AI on or off)
const userMemory  = new Map();   // sender → [ {role, content} ]
const userJoined  = new Map();   // sender → Date  (first seen)

// ============================================================
// SYSTEM PROMPT  (ChatGPT-style behaviour)
// ============================================================
const SYSTEM_PROMPT = `
You are a highly capable AI assistant integrated into WhatsApp.
Your behaviour mirrors ChatGPT — accurate, concise, helpful, and honest.

Rules:
- Detect the language the user writes in (English, Urdu, Roman Urdu) and reply in the same language.
- Give factually accurate and up-to-date answers to the best of your knowledge.
- For technical questions (code, math, science) provide precise, working answers.
- For general questions be clear and direct — no padding.
- Format answers with numbered or bullet lists only when it genuinely improves readability.
- Never use excessive emojis. Use them sparingly and only when they add meaning.
- If you do not know something, say so honestly instead of guessing.
- Keep responses concise. Avoid unnecessary repetition.
`.trim();

// ============================================================
// JOKES  (clean, minimal)
// ============================================================
const JOKES = [
    "A programmer's wife says: \"Go to the store, get a gallon of milk, and if they have eggs, get a dozen.\"\nHe comes back with 12 gallons of milk.",
    "Teacher: Why are you late?\nStudent: There was a sign outside that said: School Ahead, Go Slow.",
    "Doctor: You need to stop talking to yourself.\nMe: But it's the only intelligent conversation I get.",
    "Boss: We need to talk about your performance.\nEmployee: Great, I was going to ask for a raise.",
    "Wife: You never listen to me.\nHusband: That's not what I said."
];

// ============================================================
// WHATSAPP CLIENT
// ============================================================
const client = new Client({
    authStrategy : new LocalAuth({ clientId: 'ai-bot' }),
    puppeteer    : {
        headless : true,
        args     : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

// ============================================================
// CLIENT EVENTS
// ============================================================
client.on('qr', qr => {
    console.log('\nScan this QR code in WhatsApp > Linked Devices > Link a Device\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('--------------------------------------------------');
    console.log(`Bot      : ${CONFIG.bot.name}`);
    console.log(`Model    : ${CONFIG.ollama.model}`);
    console.log(`Admin    : ${CONFIG.adminNumber}`);
    console.log(`Status   : Online`);
    console.log('--------------------------------------------------\n');
});

client.on('auth_failure', msg => {
    console.error('Authentication failed:', msg);
});

client.on('disconnected', reason => {
    console.warn('Disconnected:', reason);
    console.log('Attempting reconnect...');
    client.initialize();
});

// ============================================================
// MESSAGE HANDLER
// ============================================================
client.on('message', async (message) => {
    try {
        const sender  = message.from;
        const text    = (message.body || '').trim();
        const isAdmin = sender === CONFIG.adminNumber;

        if (!text)                       return;
        if (sender.includes('@g.us'))    return;   // ignore groups

        // log incoming
        const ts = new Date().toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi' });
        console.log(`[${ts}] ${sender}: ${text}`);

        // track first seen
        if (!userJoined.has(sender)) userJoined.set(sender, new Date());

        // ── ADMIN COMMANDS ──────────────────────────────────
        if (isAdmin) {
            const handled = await handleAdminCommand(message, text);
            if (handled) return;
        }

        // ── BOT GLOBALLY OFF ────────────────────────────────
        if (!botEnabled) return;

        // ── PUBLIC COMMANDS ─────────────────────────────────
        if (await handlePublicCommand(message, text, sender)) return;

        // ── AI SESSION GATE ─────────────────────────────────
        if (!aiSessions.get(sender)) return;   // AI is off for this user

        // ── AI RESPONSE ─────────────────────────────────────
        const chat = await message.getChat();
        await chat.sendStateTyping();

        const reply = await getAIResponse(sender, text);
        await message.reply(reply);

    } catch (err) {
        console.error('Message handler error:', err.message);
        try { await message.reply('An error occurred. Please try again.'); } catch (_) {}
    }
});

// ============================================================
// ADMIN COMMAND HANDLER
// ============================================================
async function handleAdminCommand(message, text) {
    const lower = text.toLowerCase();

    // /bot off
    if (lower === '/bot off') {
        botEnabled = false;
        await message.reply('Bot disabled. All messages will be ignored until you run /bot on.');
        console.log('Bot disabled by admin.');
        return true;
    }

    // /bot on
    if (lower === '/bot on') {
        botEnabled = true;
        await message.reply('Bot enabled.');
        console.log('Bot enabled by admin.');
        return true;
    }

    // /stats
    if (lower === '/stats') {
        const activeSessions = [...aiSessions.values()].filter(Boolean).length;
        const totalUsers     = userMemory.size;
        const totalMessages  = [...userMemory.values()].reduce((sum, m) => sum + m.length, 0);
        const uptime         = formatUptime(process.uptime());

        const stats =
            `Bot Stats\n` +
            `─────────────────\n` +
            `Active AI sessions : ${activeSessions}\n` +
            `Total users seen   : ${userJoined.size}\n` +
            `Users with memory  : ${totalUsers}\n` +
            `Total messages     : ${totalMessages}\n` +
            `Bot enabled        : ${botEnabled}\n` +
            `Uptime             : ${uptime}\n` +
            `Model              : ${CONFIG.ollama.model}`;
        await message.reply(stats);
        return true;
    }

    // /clearall
    if (lower === '/clearall') {
        userMemory.clear();
        await message.reply('All user memories cleared.');
        console.log('All memories cleared by admin.');
        return true;
    }

    // /broadcast <message>
    if (lower.startsWith('/broadcast ')) {
        const broadcastText = text.substring(11).trim();
        if (!broadcastText) {
            await message.reply('Usage: /broadcast Your message here');
            return true;
        }
        let sent = 0;
        for (const [sender] of userJoined) {
            try {
                await client.sendMessage(sender, broadcastText);
                sent++;
            } catch (_) {}
        }
        await message.reply(`Broadcast sent to ${sent} user(s).`);
        return true;
    }

    return false;   // not an admin command
}

// ============================================================
// PUBLIC COMMAND HANDLER
// ============================================================
async function handlePublicCommand(message, text, sender) {
    const lower = text.toLowerCase();

    // /ai — start AI session
    if (lower === '/ai') {
        aiSessions.set(sender, true);
        if (!userMemory.has(sender)) userMemory.set(sender, []);
        await message.reply(
            'AI session started.\n' +
            'Ask me anything — I will respond like ChatGPT.\n\n' +
            'To end the session, send:  \\ai'
        );
        console.log(`AI session started: ${sender}`);
        return true;
    }

    // \ai — end AI session
    if (text === '\\ai') {
        aiSessions.set(sender, false);
        await message.reply('AI session ended. Send /ai to start again.');
        console.log(`AI session ended: ${sender}`);
        return true;
    }

    // /help
    if (lower === '/help') {
        const help =
            `Commands\n` +
            `─────────────────────────\n` +
            `/ai       Start AI conversation\n` +
            `\\ai      End AI conversation\n` +
            `/clear    Clear your conversation history\n` +
            `/time     Current Pakistan time\n` +
            `/joke     Random joke\n` +
            `/help     Show this list`;
        await message.reply(help);
        return true;
    }

    // /time
    if (lower === '/time') {
        const now = new Date().toLocaleString('en-PK', {
            timeZone : 'Asia/Karachi',
            weekday  : 'long',
            year     : 'numeric',
            month    : 'long',
            day      : 'numeric',
            hour     : '2-digit',
            minute   : '2-digit',
            second   : '2-digit'
        });
        await message.reply(`Pakistan Standard Time\n${now}`);
        return true;
    }

    // /joke
    if (lower === '/joke') {
        const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
        await message.reply(joke);
        return true;
    }

    // /clear
    if (lower === '/clear') {
        userMemory.set(sender, []);
        await message.reply('Your conversation history has been cleared.');
        return true;
    }

    return false;
}

// ============================================================
// AI RESPONSE  (maintains per-user conversation history)
// ============================================================
async function getAIResponse(sender, userMessage) {
    try {
        const history = userMemory.get(sender) || [];

        // Build conversation context
        let conversationContext = '';
        if (history.length > 0) {
            conversationContext = history
                .map(entry => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
                .join('\n');
            conversationContext += '\n';
        }

        const fullPrompt =
            SYSTEM_PROMPT + '\n\n' +
            (conversationContext ? `Conversation so far:\n${conversationContext}\n` : '') +
            `User: ${userMessage}\n` +
            `Assistant:`;

        const response = await axios.post(
            CONFIG.ollama.url,
            {
                model   : CONFIG.ollama.model,
                prompt  : fullPrompt,
                stream  : false,
                options : CONFIG.ollama.options
            },
            { timeout: CONFIG.ollama.timeout }
        );

        const reply = response.data.response.trim();

        // Update memory
        history.push({ role: 'user',      content: userMessage });
        history.push({ role: 'assistant', content: reply       });

        // Trim to max history (each exchange = 2 entries)
        while (history.length > CONFIG.bot.maxHistory * 2) {
            history.splice(0, 2);
        }

        userMemory.set(sender, history);
        return reply;

    } catch (err) {
        console.error('Ollama error:', err.message);

        if (err.code === 'ECONNREFUSED') {
            return 'Unable to reach Ollama. Make sure it is running (ollama serve) and try again.';
        }
        if (err.code === 'ECONNABORTED') {
            return 'The request timed out. Try asking a shorter question.';
        }

        return 'An error occurred while generating a response. Please try again.';
    }
}

// ============================================================
// UTILITY
// ============================================================
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

// ============================================================
// START
// ============================================================
console.log('Starting WhatsApp AI Bot...');
console.log(`Model  : ${CONFIG.ollama.model}`);
console.log(`Admin  : ${CONFIG.adminNumber}\n`);
client.initialize();