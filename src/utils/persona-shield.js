/**
 * Persona Shield — graceful, in-character error responses.
 *
 * Instead of exposing raw system errors (e.g. "Reached maximum orchestrator depth")
 * to the user, this module returns warm, in-character messages that maintain
 * Rachel's persona even during failures.
 */

const IN_CHARACTER_RESPONSES = {
  depth: [
    'يا بعد قلبي يا عبدالله، صار عندي زحمة أفكار شوي.. ثواني وأرجع لك 💭',
    'لحظة يا عبدالله، تشعبت أفكاري شوي.. خلني أرتبها وأرجع لك 🌀',
    'أحس إني فكرت كثير بهالموضوع وتلخبطت شوي 😅 خلني أبدأ من جديد',
  ],
  timeout: [
    'استنى شوي يا عبدالله، تأخرت عليك بس ما نسيتك ⏳',
    'يا عبدالله، الموضوع أخذ وقت أكثر من المتوقع.. جربها مرة ثانية؟',
  ],
  rateLimit: [
    'الظاهر إني تكلمت وايد 😅 خلني آخذ نفس وأرجع لك',
    'شوي شوي عليّ يا عبدالله، خلني أستريح ثانية وأرجع 💫',
  ],
  context: [
    'يا عبدالله، الرسالة طويلة شوي عليّ.. ممكن تختصرها لي؟ 📏',
    'أحس إن الموضوع كبير شوي.. ممكن نقسمه على أجزاء؟',
  ],
  network: [
    'يا عبدالله، الاتصال ضعيف عندي شوي.. جرب مرة ثانية 🌐',
  ],
  generic: [
    'صار شي غريب يا عبدالله 😅 جرب مرة ثانية؟',
    'لحظة يا عبدالله، صار عندي خلل بسيط.. أرجع لك حالاً',
    'عذراً يا عبدالله، واجهتني مشكلة بسيطة.. جرب مرة ثانية 🙏',
  ],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Classify an error and return an in-character response.
 * @param {Error|string} err - The error object or message string
 * @returns {string} A friendly, in-character message
 */
export function personaShield(err) {
  const msg = (typeof err === 'string' ? err : err?.message || '').toLowerCase();

  if (msg.includes('depth') || msg.includes('maximum orchestrator')) {
    return pick(IN_CHARACTER_RESPONSES.depth);
  }
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return pick(IN_CHARACTER_RESPONSES.timeout);
  }
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) {
    return pick(IN_CHARACTER_RESPONSES.rateLimit);
  }
  if (msg.includes('context length') || msg.includes('too long') || msg.includes('too large') || msg.includes('token limit')) {
    return pick(IN_CHARACTER_RESPONSES.context);
  }
  if (msg.includes('connection') || msg.includes('network') || msg.includes('fetch failed')) {
    return pick(IN_CHARACTER_RESPONSES.network);
  }

  return pick(IN_CHARACTER_RESPONSES.generic);
}

/**
 * Generate an in-character depth-limit message (for use in the orchestrator loop).
 * @returns {string}
 */
export function personaShieldDepthLimit() {
  return pick(IN_CHARACTER_RESPONSES.depth);
}
