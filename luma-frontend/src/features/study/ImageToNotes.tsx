import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { API, api, getApiErrorMessage } from "../../api/api";
import RequireSubscription from "../../components/RequireSubscription";
import { useAuth } from "../../context/AuthContext";
import { trackFeatureUsage } from "../../lib/analytics";

const imageToNotesStyles = `
  .luma-image-notes {
    min-height: 100vh;
    padding: 16px;
  }

  .luma-image-notes__wrap {
    max-width: 1120px;
    margin: 0 auto;
    display: grid;
    gap: 12px;
  }

  .luma-image-notes__panel {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
    box-shadow: var(--shadow);
  }

  .luma-image-notes__hero {
    display: grid;
    gap: 12px;
  }

  .luma-image-notes__eyebrow {
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

  .luma-image-notes__title {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.05;
  }

  .luma-image-notes__copy,
  .luma-image-notes__sectionCopy,
  .luma-image-notes__editorText {
    margin: 0;
    color: var(--foreground-muted);
    line-height: 1.6;
  }

  .luma-image-notes__grid {
    display: grid;
    grid-template-columns: minmax(320px, 0.95fr) minmax(0, 1.05fr);
    gap: 12px;
  }

  .luma-image-notes__section {
    display: grid;
    gap: 12px;
  }

  .luma-image-notes__sectionTitle {
    margin: 0;
    color: var(--foreground);
    font-size: 22px;
  }

  .luma-image-notes__upload {
    display: grid;
    gap: 12px;
  }

  .luma-image-notes__input {
    display: none;
  }

  .luma-image-notes__dropzone {
    border: 1px dashed rgba(181, 155, 255, 0.42);
    border-radius: 16px;
    padding: 20px;
    background: color-mix(in srgb, var(--card) 88%, rgba(181, 155, 255, 0.08));
    min-height: 240px;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: border-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
    box-shadow: var(--shadow);
  }

  .luma-image-notes__dropzone:hover {
    transform: translateY(-1px);
    border-color: rgba(140, 111, 255, 0.5);
  }

  .luma-image-notes__dropzoneContent {
    display: grid;
    gap: 12px;
    text-align: center;
    width: 100%;
  }

  .luma-image-notes__dropzoneIcon {
    width: 56px;
    height: 56px;
    margin: 0 auto;
    border-radius: 16px;
    display: grid;
    place-items: center;
    background: rgba(181, 155, 255, 0.14);
    color: var(--accent-strong);
    font-size: 24px;
  }

  .luma-image-notes__previewFrame {
    width: 100%;
    max-height: 320px;
    overflow: hidden;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
  }

  .luma-image-notes__preview {
    width: 100%;
    display: block;
    object-fit: contain;
  }

  .luma-image-notes__fileMeta {
    display: grid;
    gap: 8px;
  }

  .luma-image-notes__fileName {
    margin: 0;
    color: var(--foreground);
    font-size: 15px;
    font-weight: 700;
    word-break: break-word;
  }

  .luma-image-notes__buttonRow {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .luma-image-notes__button,
  .luma-image-notes__buttonSecondary {
    min-height: 48px;
    padding: 0 18px;
    border-radius: 16px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }

  .luma-image-notes__button {
    border: none;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    box-shadow: var(--shadow);
  }

  .luma-image-notes__buttonSecondary {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    box-shadow: var(--shadow);
  }

  .luma-image-notes__button:disabled,
  .luma-image-notes__buttonSecondary:disabled {
    cursor: not-allowed;
    opacity: 0.68;
  }

  .luma-image-notes__error {
    margin: 0;
    border-radius: 16px;
    border: 1px solid rgba(226, 120, 145, 0.28);
    background: rgba(226, 120, 145, 0.12);
    color: #b63d61;
    padding: 16px;
    line-height: 1.5;
  }

  .luma-image-notes__editor {
    min-height: 420px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    padding: 20px;
    box-shadow: var(--shadow);
    display: grid;
    align-content: start;
    gap: 12px;
  }

  .luma-image-notes__editorHeader {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-image-notes__editorBadge {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.12);
    border: 1px solid var(--border);
    color: var(--foreground);
    font-size: 13px;
    font-weight: 700;
  }

  .luma-image-notes__editorSurface {
    min-height: 280px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--card) 92%, rgba(181, 155, 255, 0.04));
    padding: 20px;
    font-family: "Consolas", "Menlo", "Monaco", monospace;
    white-space: pre-wrap;
  }

  .luma-image-notes__spinnerRow {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--foreground);
    font-weight: 700;
  }

  .luma-image-notes__spinner {
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 2px solid rgba(181, 155, 255, 0.22);
    border-top-color: var(--accent-strong);
    animation: luma-image-notes-spin 0.8s linear infinite;
  }

  @keyframes luma-image-notes-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 900px) {
    .luma-image-notes__grid {
      grid-template-columns: 1fr;
    }
  }
`;

type GenerateNotesResponse = {
  notes: string;
};

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;

      if (typeof result !== "string" || !result) {
        reject(new Error("Unable to read the selected image."));
        return;
      }

      resolve(result);
    };

    reader.onerror = () => {
      reject(new Error("Unable to read the selected image."));
    };

    reader.readAsDataURL(file);
  });
}

async function generateNotes(imageFile: File) {
  const image = await readFileAsBase64(imageFile);
  try {
    const response = await api.post<GenerateNotesResponse>(
      `${API}/api/generate-notes`,
      {
        image,
      },
    );

    if (typeof response.data?.notes !== "string") {
      throw new Error("Unable to generate notes. Try again.");
    }

    return response.data.notes;
  } catch (error) {
    throw new Error(
      getApiErrorMessage(error, "Unable to generate notes. Try again."),
    );
  }
}

function ImageToNotesTool() {
  const { user } = useAuth();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  function resetWorkspace() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedFile(null);
    setPreviewUrl("");
    setNotes("");
    setError("");
    setIsGenerating(false);
  }

  function handleSelectFile(file: File | null) {
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setError("Select an image file to continue.");
      return;
    }

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setNotes("");
    setError("");
  }

  async function handleGenerateNotes() {
    if (!selectedFile) {
      setError("Upload an image before generating notes.");
      return;
    }

    setIsGenerating(true);
    setError("");
    setNotes("");

    try {
      const generatedNotes = await generateNotes(selectedFile);
      setNotes(generatedNotes);
      trackFeatureUsage("image-to-notes", {
        surface: "study_tool",
        subscriptionStatus: user?.subscription_status ?? null,
        metadata: {
          action: "generate_notes",
          result: "success",
        },
      });
    } catch (requestError) {
      trackFeatureUsage("image-to-notes", {
        surface: "study_tool",
        subscriptionStatus: user?.subscription_status ?? null,
        metadata: {
          action: "generate_notes",
          result: "error",
        },
      });
      setError(
        requestError instanceof Error && requestError.message
          ? requestError.message
          : "Unable to generate notes. Try again.",
      );
    } finally {
      setIsGenerating(false);
    }
  }

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      handleSelectFile(event.target.files?.[0] ?? null);
    },
    [previewUrl],
  );

  const handleGenerateNotesClick = useCallback(() => {
    void handleGenerateNotes();
  }, [selectedFile, user?.subscription_status]);

  return (
    <>
      <style>{imageToNotesStyles}</style>

      <main className="luma-image-notes">
        <div className="luma-image-notes__wrap">
          <section className="luma-image-notes__panel luma-image-notes__hero">
            <span className="luma-image-notes__eyebrow">Study Tools</span>
            <h1 className="luma-image-notes__title">Image-to-Notes</h1>
            <p className="luma-image-notes__copy">
              Upload a reference image, preview it instantly, and simulate the
              note-generation flow while the AI connection is still being wired.
            </p>
          </section>

          <div className="luma-image-notes__grid">
            <section className="luma-image-notes__panel luma-image-notes__section">
              <div>
                <h2 className="luma-image-notes__sectionTitle">Upload image</h2>
                <p className="luma-image-notes__sectionCopy">
                  Use a screenshot, whiteboard photo, worksheet, or any visual
                  study material you want to turn into notes later.
                </p>
              </div>

              <div className="luma-image-notes__upload">
                <input
                  id="luma-image-notes-input"
                  className="luma-image-notes__input"
                  type="file"
                  accept="image/*"
                  onChange={handleInputChange}
                />

                <label
                  className="luma-image-notes__dropzone"
                  htmlFor="luma-image-notes-input"
                >
                  <div className="luma-image-notes__dropzoneContent">
                    {previewUrl ? (
                      <div className="luma-image-notes__previewFrame">
                        <img
                          className="luma-image-notes__preview"
                          src={previewUrl}
                          alt={selectedFile?.name || "Uploaded study material"}
                          loading="lazy"
                          decoding="async"
                        />
                      </div>
                    ) : (
                      <>
                        <span className="luma-image-notes__dropzoneIcon">🖼</span>
                        <div style={{ display: "grid", gap: 8 }}>
                          <strong
                            style={{
                              color: "var(--foreground)",
                              fontSize: 16,
                            }}
                          >
                            Click to upload an image
                          </strong>
                          <p className="luma-image-notes__sectionCopy">
                            Drag-and-drop styling is ready here. Image processing
                            will plug into this workspace later.
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                </label>

                {selectedFile ? (
                  <div className="luma-image-notes__fileMeta">
                    <p className="luma-image-notes__fileName">
                      {selectedFile.name}
                    </p>
                  <p className="luma-image-notes__sectionCopy">
                      Ready to send for AI note generation.
                    </p>
                  </div>
                ) : null}

                {error ? <p className="luma-image-notes__error">{error}</p> : null}

                <div className="luma-image-notes__buttonRow">
                  <button
                    className="luma-image-notes__button"
                    type="button"
                    onClick={handleGenerateNotesClick}
                    disabled={!selectedFile || isGenerating}
                  >
                    {isGenerating ? "Generating..." : "Generate Notes"}
                  </button>

                  <button
                    className="luma-image-notes__buttonSecondary"
                    type="button"
                    onClick={resetWorkspace}
                    disabled={!selectedFile && !notes && !error}
                  >
                    Clear
                  </button>
                </div>
              </div>
            </section>

            <section className="luma-image-notes__panel luma-image-notes__section">
              <div className="luma-image-notes__editorHeader">
                <div>
                  <h2 className="luma-image-notes__sectionTitle">Notes output</h2>
                  <p className="luma-image-notes__sectionCopy">
                    This editor-style space is where extracted notes appear
                    after image processing completes.
                  </p>
                </div>
                <span className="luma-image-notes__editorBadge">
                  AI response
                </span>
              </div>

              <div className="luma-image-notes__editor">
                <div className="luma-image-notes__editorSurface">
                  {isGenerating ? (
                    <div className="luma-image-notes__spinnerRow">
                      <span className="luma-image-notes__spinner" />
                      <span>Generating notes from your image...</span>
                    </div>
                  ) : (
                    <p className="luma-image-notes__editorText">
                      {notes ||
                        "Upload an image, then generate notes to preview the upcoming AI workflow."}
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

export default function ImageToNotes() {
  return (
    <RequireSubscription
      featureName="Image to Notes"
      title="Image to Notes is for Premium members"
      description="Upgrade to turn diagrams, screenshots, and pages into organized study notes."
    >
      <ImageToNotesTool />
    </RequireSubscription>
  );
}
