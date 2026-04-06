export const voiceMap = {
  neutral: "Google US English",
  lebron: "Microsoft David",
  taylor: "Google UK English Female",
} as const;

export const personaVoiceOptions = [
  { id: "neutral", label: "Neutral" },
  { id: "lebron", label: "LeBron" },
  { id: "taylor", label: "Taylor" },
] as const;

function normalizeVoiceValue(value: string) {
  return value.trim().toLowerCase();
}

function pickNeutralVoice(voices: SpeechSynthesisVoice[]) {
  return (
    voices.find((voiceOption) => voiceOption.default) ??
    voices.find((voiceOption) => /en[-_]?us/i.test(voiceOption.lang)) ??
    voices.find((voiceOption) => /^en/i.test(voiceOption.lang)) ??
    voices[0] ??
    null
  );
}

function pickVoice(
  voices: SpeechSynthesisVoice[],
  requestedVoiceId: string,
) {
  const normalizedRequestedVoiceId = normalizeVoiceValue(requestedVoiceId);
  const mappedVoiceName =
    voiceMap[
      normalizedRequestedVoiceId as keyof typeof voiceMap
    ] ?? voiceMap.neutral;
  const normalizedMappedVoiceName = normalizeVoiceValue(mappedVoiceName);

  const matchedVoice =
    voices.find((voiceOption) =>
      normalizeVoiceValue(voiceOption.name).includes(normalizedMappedVoiceName),
    ) ??
    voices.find((voiceOption) =>
      normalizeVoiceValue(voiceOption.voiceURI).includes(
        normalizedMappedVoiceName,
      ),
    );

  return matchedVoice ?? pickNeutralVoice(voices);
}

async function loadSpeechVoices() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return [] as SpeechSynthesisVoice[];
  }

  const synthesis = window.speechSynthesis;
  const immediatelyAvailableVoices = synthesis.getVoices();

  if (immediatelyAvailableVoices.length > 0) {
    return immediatelyAvailableVoices;
  }

  await new Promise<void>((resolve) => {
    const handleVoicesChanged = () => {
      cleanup();
      resolve();
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 250);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      synthesis.removeEventListener("voiceschanged", handleVoicesChanged);
    };

    synthesis.addEventListener("voiceschanged", handleVoicesChanged, {
      once: true,
    });
  });

  return synthesis.getVoices();
}

export async function speak(text: string, voiceId: string) {
  if (
    typeof window === "undefined" ||
    typeof text !== "string" ||
    !text.trim() ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return;
  }

  const synthesis = window.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text.trim());
  const voices = await loadSpeechVoices();
  const selectedVoice = pickVoice(voices, voiceId);

  if (selectedVoice) {
    utterance.voice = selectedVoice;
    utterance.lang = selectedVoice.lang;
  }

  utterance.rate = 1;
  utterance.pitch = 1;

  synthesis.cancel();
  synthesis.speak(utterance);
}
