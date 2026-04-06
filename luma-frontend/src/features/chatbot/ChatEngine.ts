import type { PersonaDefinition } from "../personas/personaTypes";

export type ChatBot = {
  name: string;
  systemPrompt: string;
  voice: string;
  avatar?: string | null;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

export const CHAT_LANGUAGE_POLICY =
  "You can use casual language and mild profanity when it fits the tone of the conversation, but you must never use slurs, hate speech, or target individuals or groups. Stay helpful, respectful, and focused on learning and clarity.";

export function createPersonaBot(persona: PersonaDefinition): ChatBot {
  return {
    name: persona.name,
    systemPrompt: `${persona.system_prompt}\n\n${CHAT_LANGUAGE_POLICY}`,
    voice: persona.voice_id,
    avatar: persona.avatar_url,
  };
}

function buildMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildPlaceholderReply(bot: ChatBot, message: string) {
  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    return `${bot.name} is ready whenever you are.`;
  }

  return `${bot.name} heard: "${trimmedMessage}". AI replies will plug into this ${bot.voice} chatbot soon.`;
}

export async function sendMessage(bot: ChatBot, message: string): Promise<ChatMessage> {
  const trimmedMessage = message.trim();

  if (!trimmedMessage) {
    throw new Error("Enter a message before sending.");
  }

  await new Promise((resolve) => {
    window.setTimeout(resolve, 280);
  });

  return {
    id: buildMessageId(),
    role: "assistant",
    content: buildPlaceholderReply(bot, trimmedMessage),
    createdAt: new Date().toISOString(),
  };
}
