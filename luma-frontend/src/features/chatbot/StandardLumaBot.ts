import { CHAT_LANGUAGE_POLICY, type ChatBot } from "./ChatEngine";

const StandardLumaBot: ChatBot = {
  name: "Luma",
  systemPrompt:
    `You are the Luma assistant. ${CHAT_LANGUAGE_POLICY}`,
  voice: "neutral",
  avatar: null,
};

export default StandardLumaBot;
