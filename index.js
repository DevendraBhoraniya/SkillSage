import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY||process.env.GOOGLE_API_KEY_1);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_API_KEY||process.env.GOOGLE_API_KEY_1);

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const chats = {}; // Store chat history for different users


// console.log("API keys ---", process.env.GOOGLE_API_KEY)
// console.log("API keys ---", process.env.TELEGRAM_BOT_TOKEN)

const subjects = ['Math', 'Science', 'History', 'Literature', 'Computer Science'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// to get getSubjectMenu
function getSubjectMenu() {
    return {
        reply_markup: JSON.stringify({
            inline_keyboard: subjects.map(subject => ([{ text: subject, callback_data: `subject:${subject}` }]))
        })
    };
}


bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const options = {
        reply_markup: JSON.stringify({
            inline_keyboard: subjects.map(subject => ([{ text: subject, callback_data: `subject:${subject}` }]))
        })
    };
    bot.sendMessage(chatId, "Welcome to the AI Teacher SkillSage! Please select a subject you'd like to learn:", options);
});

bot.onText(/\/end/, (msg) => {
    const chatId = msg.chat.id;
    if (chats[chatId]) {
        delete chats[chatId];
        bot.sendMessage(chatId, "Conversation ended and all data deleted. Type /start to begin a new conversation.");
    } else {
        bot.sendMessage(chatId, "There's no active conversation to end. Type /start to begin a new conversation.");
    }
});

bot.onText(/\/restart/, (msg) => {
    const chatId = msg.chat.id;
    if (chats[chatId]) {
        delete chats[chatId];
    }
    bot.sendMessage(chatId, "Let's start over! Please select a subject:", getSubjectMenu());
});


bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    if (data.startsWith('subject:')) {
        const subject = data.split(':')[1];
        chats[chatId] = {
            subject,
            chat: model.startChat({
                generationConfig: {
                    maxOutputTokens: 450,
                },
            }),
            history: []
        };

        bot.answerCallbackQuery(callbackQuery.id);
        bot.sendMessage(chatId, `Great! You've selected ${subject}. I'm your AI teacher specialized in ${subject}. What would you like to know about ${subject}? Feel free to ask any question, and I'll do my best to help you learn!`);
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;

    if (messageText === '/start' || messageText === '/end' || messageText === '/restart') return; // Ignore these commands

    // Check if the user has selected a subject
    if (!chats[chatId]) {
        bot.sendMessage(chatId, "Please start by selecting a subject using the /start command.");
        return;
    }

    // Check if the message contains a photo
    if (msg.photo) {
        await handleImage(msg, chatId);
        return;
    }

    // Handle text messages
    await handleTextMessage(messageText, chatId);
});


// to Fix polling Error 
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code);  // Log the error for debugging
    if (error.code === 'ETELEGRAM' && error.response && error.response.statusCode === 409) {
        console.log('Another instance is running. Restarting polling...');
        bot.stopPolling();  // Stop the current polling
        setTimeout(() => {
            bot.startPolling();  // Restart polling after a delay
        }, 3000);  // Wait for 3 seconds before restarting
    }
});


async function handleImage(msg, chatId) {
    try {
        // Show Image is Uploading
        bot.sendChatAction(chatId, 'upload_photo');

        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);
        const filePath = file.file_path;
        const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
        const localFilePath = path.join(tempDir, `temp_image_${chatId}.jpg`);
        await downloadImage(downloadUrl, localFilePath);

        const fileSize = fs.statSync(localFilePath).size;
        let result;

        if (fileSize > 20 * 1024 * 1024) {
            // Use File API for larger files
            const uploadResponse = await fileManager.uploadFile(localFilePath, {
                mimeType: "image/jpeg",
                displayName: "Telegram image",
            });

            result = await model.generateContent([
                {
                    fileData: {
                        mimeType: uploadResponse.file.mimeType,
                        fileUri: uploadResponse.file.uri
                    }
                },
                { text: `Analyze this image and determine if it's related to ${chats[chatId].subject}. If it is, describe it in detail. If it's not, provide a brief description and remind the user to stay focused on their studies.` }
            ]);
        } else {
            // Use inline data for smaller files
            const fileContent = fs.readFileSync(localFilePath, { encoding: 'base64' });
            result = await model.generateContent([
                {
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: fileContent
                    }
                },
                { text: `Analyze this image and determine if it's related to ${chats[chatId].subject}. If it is, describe it in detail. If it's not, provide a brief description and remind the user to stay focused on their studies.` }
            ]);
        }

        const responseText = result.response.text();
        bot.sendMessage(chatId, responseText);

        // Set a flag to indicate an image is active
        chats[chatId].activeImage = true;

        // Set a timeout to remove the image after 2 minutes if no questions are asked
        setTimeout(() => {
            if (chats[chatId] && chats[chatId].activeImage) {
                fs.unlinkSync(localFilePath);
                delete chats[chatId].activeImage;
                bot.sendMessage(chatId, "The uploaded image has been removed as no questions were asked about it. Remember to stay focused on your studies!");
            }
        }, 120000); // 2 minutes in milliseconds

    } catch (error) {
        console.error('Error processing image:', error);
        bot.sendMessage(chatId, "Sorry, I encountered an error while processing the image.");
    }
}



async function handleTextMessage(messageText, chatId) {
    try {
        if (!chats[chatId] || !chats[chatId].subject) {
            bot.sendMessage(chatId, "Please start by selecting a subject using the /start command.");
            return;
        }

        // Show "typing" indicator
        bot.sendChatAction(chatId, 'typing');

        const subject = chats[chatId].subject;

        // Check for restart or end commands
        if (messageText.toLowerCase() === '/restart') {
            delete chats[chatId];
            bot.sendMessage(chatId, "Let's start over! Please select a subject:", getSubjectMenu());
            return;
        } else if (messageText.toLowerCase() === '/end') {
            delete chats[chatId];
            bot.sendMessage(chatId, "Conversation ended and all data deleted. Type /start to begin a new conversation.");
            return;
        }

        let prompt;
        if (chats[chatId].activeImage) {
            prompt = `Regarding the recently uploaded image and ${subject}: ${messageText}
            Please answer the question about the image content. If the question or image is not related to ${subject}, provide a brief answer and gently remind the user to focus on ${subject}-related topics.`;
            
            // Reset the image removal timeout
            clearTimeout(chats[chatId].imageTimeout);
            chats[chatId].imageTimeout = setTimeout(() => {
                if (chats[chatId] && chats[chatId].activeImage) {
                    fs.unlinkSync(path.join(tempDir, `temp_image_${chatId}.jpg`));
                    delete chats[chatId].activeImage;
                    bot.sendMessage(chatId, "The uploaded image has been removed. Let's continue focusing on your ${subject} studies!");
                }
            }, 120000); // Reset to 2 minutes
        } else {
            prompt = `You are an AI teacher specialized in ${subject}. The student has asked: "${messageText}"
            
            Please provide a response following these guidelines:
            1. Focus solely on ${subject}-related information.
            2. If the question is not related to ${subject}, politely redirect the student and provide a brief ${subject}-related fact instead.
            3. Use *bold* for emphasis and headings.
            4. Use _italic_ for slight emphasis.
            5. Use \`inline code\` for short mathematical expressions or variables.
            6. Use \`\`\` for multi-line equations or code blocks.
            7. Use - for bullet points and 1. for numbered lists.
            8. For complex mathematical equations, use plain text representation.
            9. Ensure proper spacing between list items and equations.
            10. Keep the answer concise, aiming for about 400 tokens.
            11. End with a follow-up question to encourage further learning about ${subject}.`;
        }

        const result = await chats[chatId].chat.sendMessage(prompt);
        let responseText = await result.response.text();

        console.log("Original response ----", responseText);

        // Ensure proper line breaks for lists and equations
        responseText = responseText.replace(/\n([*-])/g, '\n\n$1');
        responseText = responseText.replace(/\n(\d+\.)/g, '\n\n$1');
        responseText = responseText.replace(/\n(```)/g, '\n\n$1');

        // Improve formatting for inline mathematical expressions
        responseText = responseText.replace(/\$([^$]+)\$/g, '`$1`');

        chats[chatId].history.push({ role: "user", parts: messageText }, { role: "model", parts: responseText });

        // Send the response with Markdown parsing
        bot.sendMessage(chatId, responseText, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        }).catch(error => {
            console.error('Error sending formatted message:', error);
            // If Markdown parsing fails, send the message without formatting
            bot.sendMessage(chatId, "Sorry, I couldn't format the message properly. Here's the plain text version:\n\n" + responseText.replace(/[*_`]/g, ''));
        });
    } catch (error) {
        console.error('Error generating content:', error);
        bot.sendMessage(chatId, "Sorry, I encountered an error. Please try again.");
    }
}

// Function to fetch and save image
async function downloadImage(url, filepath) {
    const response = await fetch(url);
    const buffer = await response.buffer();
    fs.writeFileSync(filepath, buffer);
}

// Function to get file data
function getFileData(filepath) {
    return {
        fileData: fs.readFileSync(filepath), // Direct binary data
        mimeType: 'image/jpeg', // Correctly specify the MIME type
    };
}

console.log('Bot is running...');
