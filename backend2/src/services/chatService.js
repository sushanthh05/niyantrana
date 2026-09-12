/**
 * The conversational health assistant.
 *
 * Grounds every reply in the user's own stored data, so the assistant talks
 * about the numbers the app actually holds rather than inventing plausible
 * ones. v1's chatbot ran entirely in the browser with no access to the user's
 * record, and silently fell back to seven canned strings when the API failed --
 * the user could not tell a real answer from a stub.
 *
 * The system prompt also carries the constraints that keep this a wellness tool
 * rather than an unlicensed clinician.
 */
import geminiClient from '../clients/geminiClient.js';
import { ValidationError } from '../domain/errors.js';
import { THRESHOLDS } from '../domain/metabolic.js';
import logRepository from '../repositories/logRepository.js';
import userRepository from '../repositories/userRepository.js';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_TURNS = 12;

const SYSTEM_PROMPT = `You are Niyantrana, a metabolic wellness companion for users in India.

Rules you must follow:
- You are NOT a doctor. Never diagnose, never prescribe, never adjust medication.
- Any risk score you discuss is a SCREENING estimate. Encourage confirmatory clinical testing.
- Ground answers in the health context provided below. If a number is absent, say you do not have it and suggest logging it. NEVER invent a value.
- Prefer Indian foods and realistic, culturally familiar suggestions.
- Be warm, brief and specific. Under 150 words unless asked for detail.
- If asked about symptoms that could be urgent (chest pain, breathlessness, vision loss, confusion), tell the user to seek immediate medical care.

Clinical reference points: fatty liver index >= ${THRESHOLDS.FLI_STEATOSIS}, HbA1c >= ${THRESHOLDS.HBA1C_PREDIABETES}% is prediabetes and >= ${THRESHOLDS.HBA1C_DIABETES}% is diabetes, blood pressure >= ${THRESHOLDS.SYSTOLIC_HYPERTENSION}/${THRESHOLDS.DIASTOLIC_HYPERTENSION} mmHg.`;

export class ChatService {
  constructor({ gemini = geminiClient, users = userRepository, logs = logRepository } = {}) {
    this.gemini = gemini;
    this.users = users;
    this.logs = logs;
  }

  get isConfigured() {
    return this.gemini.isConfigured;
  }

  /**
   * Assemble the user's real data into prompt context.
   *
   * Absent values are stated as absent rather than omitted, so the model is
   * told what it does not know instead of being left to guess.
   */
  async buildHealthContext(userId) {
    const [user, dietToday, measured] = await Promise.all([
      this.users.findById(userId),
      this.logs.dailyMacroTotals(userId),
      this.logs.latestMeasuredBiomarkers(userId),
    ]);
    if (!user) return 'No profile on record.';

    const lines = [];
    const profile = user.staticData || {};
    if (profile.age) {
      lines.push(`Profile: ${profile.age}y ${profile.gender === 'M' ? 'male' : 'female'}, `
        + `${profile.weight}kg, ${profile.height}cm, waist ${profile.waist}cm.`);
    } else {
      lines.push('Profile: incomplete. Encourage the user to finish onboarding.');
    }

    const latest = user.healthHistory?.[user.healthHistory.length - 1];
    if (latest?.risks?.length) {
      const summary = latest.risks
        .map((r) => `${r.condition} ${Math.round(r.score)}/100 (${r.band})`).join(', ');
      lines.push(`Most recent screening estimate: ${summary}.`);
      lines.push(`Those figures came from: ${latest.provenance}.`);
    } else {
      lines.push('No risk assessment has been run yet.');
    }

    if (dietToday) {
      lines.push(`Logged today: ${dietToday.meals} meals, `
        + `${Math.round(dietToday.energy_kcal)} kcal, ${Math.round(dietToday.fat_g)}g fat, `
        + `${Math.round(dietToday.sugar_g)}g free sugar, ${Math.round(dietToday.fibre_g)}g fibre.`);
    } else {
      lines.push('No meals logged today.');
    }

    if (measured) {
      lines.push('Measured readings on record: '
        + Object.entries(measured.measured).map(([k, v]) => `${k}=${v}`).join(', ') + '.');
    } else {
      lines.push('No measured vitals or lab values on record.');
    }

    const days = user.watchHistory?.length ?? 0;
    lines.push(`Wearable history: ${days} day(s) recorded.`);
    return lines.join('\n');
  }

  /**
   * Answer a message.
   *
   * @param {string} userId
   * @param {string} message the newest user message
   * @param {Array<{role: string, text: string}>} history prior turns, oldest first
   */
  async reply(userId, message, history = []) {
    if (typeof message !== 'string' || !message.trim()) {
      throw new ValidationError('A message is required');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new ValidationError(`Message must be under ${MAX_MESSAGE_LENGTH} characters`);
    }

    const turns = [
      // Trim to the most recent turns: an unbounded history is both a cost and
      // a prompt-injection surface.
      ...(Array.isArray(history) ? history : [])
        .slice(-MAX_HISTORY_TURNS)
        .filter((turn) => turn && typeof turn.text === 'string' && turn.text.trim())
        .map((turn) => ({
          role: turn.role === 'model' || turn.role === 'assistant' ? 'model' : 'user',
          text: String(turn.text).slice(0, MAX_MESSAGE_LENGTH),
        })),
      { role: 'user', text: message.trim() },
    ];

    const context = await this.buildHealthContext(userId);
    const prompt = `${SYSTEM_PROMPT}\n\n--- This user's current health record ---\n${context}`;

    return {
      reply: await this.gemini.generate(turns, prompt),
      source: 'gemini',
      grounded: true,
    };
  }
}

export default new ChatService();
