/**
 * Voice request detection utility
 * Detects if the user's message explicitly requests voice/audio output
 */

/**
 * Detects if the user's message explicitly requests voice/audio output
 * @param {string} userMessage - The user's message text
 * @returns {boolean} - True if the user asked for voice, false otherwise
 */
export function shouldSendVoice(userMessage) {
  if (!userMessage) return false;

  const lowerMessage = userMessage.toLowerCase();

  // English voice request keywords
  const englishVoiceKeywords = [
    'speak', 'voice', 'hear you', 'hear me', 'talk to me', 'say it',
    'read this', 'read it', 'read me', 'say this', 'say that',
    'audio', 'sound', 'voice message', 'voice reply', 'speak to me',
    'tell me', 'say out loud', 'pronounce', 'speak out', 'vocalize',
    'send voice', 'send audio', 'voice output', 'audio output',
    'i want to hear', 'i need to hear', 'please speak', 'can you speak',
    'can you say', 'would you say', 'would you speak'
  ];

  // Arabic voice request keywords
  const arabicVoiceKeywords = [
    'قولي بصوتك', // say it in your voice
    'أبي أسمعك', // I want to hear you
    'كلميني', // talk to me
    'اسمعني', // let me hear
    'صوت', // voice
    'صوتي', // voice me
    'بصوت', // in voice
    'اقرأ', // read
    'اقرأ لي', // read to me
    'قول', // say
    'قول لي', // say to me
    'تكلم', // speak
    'تكلم معي', // speak with me
    'أسمع صوتك', // let me hear your voice
    'أريد أسمعك', // I want to hear you
    'أريد صوتك', // I want your voice
    'أرسل صوت', // send voice
    'رسالة صوتية', // voice message
  ];

  // Check English keywords
  for (const keyword of englishVoiceKeywords) {
    if (lowerMessage.includes(keyword)) {
      return true;
    }
  }

  // Check Arabic keywords
  for (const keyword of arabicVoiceKeywords) {
    if (userMessage.includes(keyword)) {
      return true;
    }
  }

  return false;
}
