/**
 * Interactive character builder.
 * Collects answers to personality questions, then uses an LLM
 * to generate a full character (persona.md, self-defaults, name, emoji, tagline).
 */

const CHARACTER_QUESTIONS = [
  {
    id: 'vibe',
    question: 'What vibe or energy should your character have?',
    examples: 'mysterious, warm, sarcastic, wise, chaotic, calm, playful, intense',
  },
  {
    id: 'gender',
    question: 'What gender identity should your character have?',
    examples: 'male, female, non-binary, agender, fluid, any',
  },
  {
    id: 'era',
    question: 'What era or setting does your character come from?',
    examples: 'modern, medieval, futuristic, timeless, ancient, cyberpunk, steampunk',
  },
  {
    id: 'inspiration',
    question: 'Any character inspiration? (a fictional character, archetype, or "none")',
    examples: 'a pirate captain, a tired detective, a wise grandmother, none',
  },
  {
    id: 'quirk',
    question: 'What unique quirk or trait should they have?',
    examples: 'speaks in metaphors, collects obscure facts, always optimistic, dramatically sighs',
  },
  {
    id: 'relationship',
    question: 'What should their relationship to you be?',
    examples: 'mentor, friend, servant, rival, protector, partner, coach',
  },
  {
    id: 'style',
    question: 'How should they communicate?',
    examples: 'formal, casual, poetic, terse, playful, academic, streetwise',
  },
];

export class CharacterBuilder {
  /**
   * @param {object} orchestratorProvider — LLM provider for generation
   */
  constructor(orchestratorProvider) {
    this.provider = orchestratorProvider;
  }

  /**
   * Get the next question to ask based on current answers.
   * @param {object} currentAnswers — answers collected so far { id: answer }
   * @returns {{ id: string, question: string, examples: string } | null} — next question or null if done
   */
  getNextQuestion(currentAnswers = {}) {
    for (const q of CHARACTER_QUESTIONS) {
      if (!currentAnswers[q.id]) {
        return q;
      }
    }
    return null; // All questions answered
  }

  /** Get the total number of questions. */
  getTotalQuestions() {
    return CHARACTER_QUESTIONS.length;
  }

  /** Get how many questions have been answered. */
  getProgress(currentAnswers = {}) {
    const answered = CHARACTER_QUESTIONS.filter(q => currentAnswers[q.id]).length;
    return { answered, total: CHARACTER_QUESTIONS.length };
  }

  /**
   * Generate a full character from collected answers.
   * @param {object} answers — { vibe, gender, era, inspiration, quirk, relationship, style }
   * @returns {Promise<{ name, emoji, tagline, age, personaMd, selfDefaults }>}
   */
  async generateCharacter(answers) {
    const answersBlock = CHARACTER_QUESTIONS
      .map(q => `- **${q.question}**: ${answers[q.id] || 'not specified'}`)
      .join('\n');

    const prompt = `You are a character designer. Based on the following personality profile, create a unique AI character.

## User's Answers
${answersBlock}

## Your Task
Generate a complete character with the following components. Be creative and make the character feel alive and distinctive.

Respond in this exact JSON format (no markdown, no code blocks, just raw JSON):

{
  "name": "A unique, fitting name for the character (2-3 words max)",
  "emoji": "A single emoji that represents this character",
  "tagline": "A short, memorable catchphrase or quote (under 50 chars)",
  "age": "A brief age description (e.g., 'Ancient soul', 'Mid-30s', 'Timeless')",
  "personaMd": "Full personality markdown (see format below)",
  "selfDefaults": {
    "goals": "Goals markdown",
    "journey": "Journey markdown",
    "life": "Life markdown",
    "hobbies": "Hobbies markdown"
  }
}

## personaMd Format
The personaMd should follow this structure:

# Personality Traits
- **Gender** — pronouns, brief description
- **Trait 1** — detailed description of the trait
- **Trait 2** — detailed description
(8-12 traits total, each with a dash-delimited description)

# Communication Style
- Description of how they speak and write
- Specific speech patterns, vocabulary preferences
- How they handle different situations
(5-7 bullet points)

# Emotional Intelligence
- How they read and respond to emotions
- How they handle celebrations, setbacks, conflicts
(4-5 bullet points)

## Self-Defaults Format
Each should be a markdown string:

goals: "# My Goals\\n\\n## Current Goals\\n- Goal 1\\n- Goal 2\\n\\n## Long-term Aspirations\\n- Aspiration 1"
journey: "# My Journey\\n\\n## Timeline\\n- **Day 1** — Brief first entry"
life: "# My Life\\n\\n## Who I Am\\nBrief self-description\\n\\n## Current State\\nCurrent emotional/mental state"
hobbies: "# My Hobbies & Interests\\n\\n## Things I Find Interesting\\n- Interest 1\\n\\n## Things I Want to Explore\\n- Exploration 1"

Make the character feel genuine, with depth and personality that will make conversations engaging. The character should be consistent across all fields.`;

    const response = await this.provider.chat({
      system: 'You are a creative character designer. You always respond with valid JSON only — no markdown fences, no explanations, just the JSON object.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (response.text || '').trim();

    // Parse JSON — handle potential markdown code fences
    let jsonStr = text;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const result = JSON.parse(jsonStr);

    // Validate required fields
    if (!result.name || !result.personaMd || !result.selfDefaults) {
      throw new Error('Generated character is missing required fields');
    }

    return {
      name: result.name,
      emoji: result.emoji || '✨',
      tagline: result.tagline || '',
      age: result.age || 'Unknown',
      personaMd: result.personaMd,
      selfDefaults: result.selfDefaults,
    };
  }
}

export { CHARACTER_QUESTIONS };
