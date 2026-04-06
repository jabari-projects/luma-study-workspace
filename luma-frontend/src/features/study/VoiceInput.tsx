import { useEffect, useRef, useState } from "react";
import { api, getApiErrorMessage } from "../../api/api";
import RequireSubscription from "../../components/RequireSubscription";
import { useAuth } from "../../context/AuthContext";
import { trackFeatureUsage } from "../../lib/analytics";

type TranscribeResponse = {
  transcript: string;
};

const voiceInputStyles = `
  .luma-voice-input {
    min-height: 100vh;
    padding: 16px;
  }

  .luma-voice-input__wrap {
    max-width: 1040px;
    margin: 0 auto;
    display: grid;
    gap: 12px;
  }

  .luma-voice-input__panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
  }

  .luma-voice-input__hero,
  .luma-voice-input__section {
    display: grid;
    gap: 12px;
  }

  .luma-voice-input__eyebrow {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .luma-voice-input__title {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.05;
  }

  .luma-voice-input__copy,
  .luma-voice-input__sectionCopy {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-voice-input__controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .luma-voice-input__button,
  .luma-voice-input__buttonSecondary {
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }

  .luma-voice-input__button {
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    box-shadow: var(--shadow);
  }

  .luma-voice-input__buttonSecondary {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    box-shadow: var(--shadow);
  }

  .luma-voice-input__button:disabled,
  .luma-voice-input__buttonSecondary:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .luma-voice-input__status {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    width: fit-content;
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(181, 155, 255, 0.08);
    color: var(--foreground);
    font-size: 14px;
    font-weight: 700;
  }

  .luma-voice-input__dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: #8c6fff;
  }

  .luma-voice-input__dot.is-recording {
    background: #e27891;
    box-shadow: 0 0 0 6px rgba(226, 120, 145, 0.16);
  }

  .luma-voice-input__fallback {
    border-radius: 16px;
    border: 1px solid rgba(226, 120, 145, 0.28);
    background: rgba(226, 120, 145, 0.12);
    color: #b63d61;
    padding: 20px;
    line-height: 1.6;
  }

  .luma-voice-input__editor {
    min-height: 320px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--card) 92%, rgba(181, 155, 255, 0.04));
    padding: 20px;
    box-shadow: var(--shadow);
    font-family: "Consolas", "Menlo", "Monaco", monospace;
    white-space: pre-wrap;
  }

  .luma-voice-input__output {
    margin: 0;
    color: var(--foreground);
    line-height: 1.7;
  }

  .luma-voice-input__placeholder {
    color: var(--foreground-muted);
  }

  .luma-voice-input__spinnerRow {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--foreground);
    font-weight: 700;
  }

  .luma-voice-input__spinner {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 2px solid rgba(181, 155, 255, 0.22);
    border-top-color: var(--accent-strong);
    animation: luma-voice-input-spin 0.8s linear infinite;
  }

  @keyframes luma-voice-input-spin {
    to {
      transform: rotate(360deg);
    }
  }
`;

function isVoiceRecordingSupported() {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

async function transcribeAudio(blob: Blob) {
  const formData = new FormData();
  formData.append("audio", blob, "voice-input.webm");

  try {
    const response = await api.post<TranscribeResponse>(
      "/api/transcribe",
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
      },
    );

    if (typeof response.data?.transcript !== "string") {
      throw new Error("Unable to transcribe audio. Try again.");
    }

    return response.data.transcript;
  } catch (error) {
    throw new Error(
      getApiErrorMessage(error, "Unable to transcribe audio. Try again."),
    );
  }
}

function VoiceInputTool() {
  const { user } = useAuth();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [transcript, setTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const isSupported = isVoiceRecordingSupported();

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stream.getTracks().forEach((track) => {
        track.stop();
      });
      mediaRecorderRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
      mediaStreamRef.current = null;
    };
  }, []);

  async function handleStartRecording() {
    if (!isSupported || isRecording || isTranscribing) {
      return;
    }

    setErrorMessage("");
    setTranscript("");
    audioChunksRef.current = [];

    mediaStreamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setErrorMessage("Voice recording could not start. Please try again.");
        setIsRecording(false);
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
      };

      recorder.onstop = () => {
        const recordedBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });

        audioChunksRef.current = [];
        setIsRecording(false);
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;

        if (!recordedBlob.size) {
          setErrorMessage("No audio was captured. Please try again.");
          return;
        }

        setIsTranscribing(true);
        setErrorMessage("");

        void (async () => {
          try {
            const text = await transcribeAudio(recordedBlob);
            setTranscript(text.trim());
            trackFeatureUsage("voice-input", {
              surface: "study_tool",
              subscriptionStatus: user?.subscription_status ?? null,
              metadata: {
                action: "transcribe",
                result: "success",
              },
            });
          } catch (requestError) {
            trackFeatureUsage("voice-input", {
              surface: "study_tool",
              subscriptionStatus: user?.subscription_status ?? null,
              metadata: {
                action: "transcribe",
                result: "error",
              },
            });
            setErrorMessage(
              requestError instanceof Error && requestError.message
                ? requestError.message
                : "Unable to transcribe audio. Try again.",
            );
          } finally {
            setIsTranscribing(false);
          }
        })();
      };

      recorder.start();
      setIsRecording(true);
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError")
      ) {
        setErrorMessage(
          "Microphone access was blocked. Allow microphone permissions to use voice input.",
        );
      } else {
        setErrorMessage("Voice recording could not start. Please try again.");
      }

      setIsRecording(false);
    }
  }

  function handleStopRecording() {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      return;
    }

    mediaRecorderRef.current.stop();
    setIsRecording(false);
  }

  return (
    <>
      <style>{voiceInputStyles}</style>

      <main className="luma-voice-input">
        <div className="luma-voice-input__wrap">
          <section className="luma-voice-input__panel luma-voice-input__hero">
            <span className="luma-voice-input__eyebrow">Study Tools</span>
            <h1 className="luma-voice-input__title">Voice Input</h1>
            <p className="luma-voice-input__copy">
              Capture spoken notes directly in the browser, then send the
              recording for AI transcription without changing your study flow.
            </p>
          </section>

          <section className="luma-voice-input__panel luma-voice-input__section">
            <div>
              <h2
                style={{
                  margin: 0,
                  color: "var(--foreground)",
                  fontSize: 22,
                }}
              >
                Voice-to-text
              </h2>
              <p className="luma-voice-input__sectionCopy">
                Start recording to capture your voice and send the finished
                audio clip for AI transcription.
              </p>
            </div>

            {!isSupported ? (
              <div className="luma-voice-input__fallback" role="alert">
                Voice recording is not supported in this browser. Try a modern
                browser with microphone access enabled.
              </div>
            ) : (
              <>
                <div className="luma-voice-input__controls">
                  <button
                    className="luma-voice-input__button"
                    type="button"
                    onClick={handleStartRecording}
                    disabled={isRecording || isTranscribing}
                  >
                    Start Recording
                  </button>
                  <button
                    className="luma-voice-input__buttonSecondary"
                    type="button"
                    onClick={handleStopRecording}
                    disabled={!isRecording}
                  >
                    Stop Recording
                  </button>
                </div>

                <div className="luma-voice-input__status">
                  <span
                    className={`luma-voice-input__dot${
                      isRecording ? " is-recording" : ""
                    }`}
                  />
                  {isRecording
                    ? "Listening..."
                    : isTranscribing
                      ? "Transcribing..."
                      : "Ready to record"}
                </div>

                {errorMessage ? (
                  <div className="luma-voice-input__fallback" role="alert">
                    {errorMessage}
                  </div>
                ) : null}

                <div className="luma-voice-input__editor">
                  {isTranscribing ? (
                    <div className="luma-voice-input__spinnerRow">
                      <span className="luma-voice-input__spinner" />
                      <span>Transcribing your audio...</span>
                    </div>
                  ) : (
                    <p
                      className={`luma-voice-input__output${
                        transcript ? "" : " luma-voice-input__placeholder"
                      }`}
                    >
                      {transcript ||
                        "Your transcribed speech will appear here once you start recording."}
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

export default function VoiceInput() {
  return (
    <RequireSubscription
      featureName="Voice Input"
      title="Voice Input is for Premium members"
      description="Upgrade to capture spoken ideas and turn them into written study material."
    >
      <VoiceInputTool />
    </RequireSubscription>
  );
}
