import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { api, getApiErrorMessage, type AuthUser } from "../api/api";
import ApiErrorBoundary from "../components/ApiErrorBoundary";
import PageSkeleton from "../components/PageSkeleton";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { getUsernameAvatarLetter } from "../utils/avatar";

type ThemeMode = "light" | "dark";

type FormValues = {
  username: string;
  display_name: string;
  timezone: string;
  theme_mode: ThemeMode;
  phone_number: string;
  birthday: string;
};

type FormErrors = Partial<Record<keyof FormValues, string>>;

const FILE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Australia/Sydney",
];

const styles = `
.ps-page{min-height:100vh;padding:32px 20px 48px}
.ps-wrap{max-width:1180px;margin:0 auto;display:grid;gap:24px}
.ps-header,.ps-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.ps-chip{display:inline-flex;align-items:center;padding:8px 14px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;background:var(--ps-soft);border:1px solid var(--ps-border);color:#8c6fff}
.ps-title{margin:14px 0 6px;font-size:clamp(2rem,4vw,3rem);line-height:1.05;color:var(--ps-text)}
.ps-subtitle,.ps-copy,.ps-help{margin:0;color:var(--ps-muted);line-height:1.6}
.ps-actions,.ps-inline{display:flex;gap:16px;flex-wrap:wrap}
.ps-link,.ps-secondary,.ps-segment,.ps-danger-action,.ps-primary{position:relative;overflow:hidden;transition:transform var(--theme-transition),box-shadow var(--theme-transition),border-color var(--theme-transition),background var(--theme-transition),color var(--theme-transition)}
.ps-link,.ps-secondary,.ps-segment,.ps-danger-action{border:1px solid var(--ps-border);background:rgba(38,38,38,.92);color:#e5e7eb;border-radius:12px;padding:14px 16px;font-weight:700;text-decoration:none;cursor:pointer;box-shadow:var(--ps-card-shadow)}
html[data-theme="light"] .ps-link,html[data-theme="light"] .ps-secondary,html[data-theme="light"] .ps-segment,html[data-theme="light"] .ps-danger-action{background:var(--ps-surface);color:var(--ps-text)}
.ps-link:hover,.ps-secondary:hover,.ps-segment:hover,.ps-danger-action:hover,.ps-primary:hover{transform:translateY(-1px);box-shadow:var(--ps-shadow)}
.ps-link:focus-visible,.ps-secondary:focus-visible,.ps-segment:focus-visible,.ps-danger-action:focus-visible,.ps-primary:focus-visible,.ps-input:focus-visible,.ps-file:focus-visible{outline:none;box-shadow:0 0 0 4px rgba(99,102,241,.16),var(--ps-card-shadow)}
.ps-form,.ps-stack{display:grid;gap:24px}
.ps-hero{position:relative;overflow:hidden;border-radius:32px;min-height:320px;padding:28px clamp(20px,4vw,36px);background-size:cover;background-position:center;border:1px solid var(--ps-border);box-shadow:var(--ps-shadow)}
.ps-hero::after{content:"";position:absolute;inset:auto -100px -120px auto;width:260px;height:260px;border-radius:50%;background:rgba(255,255,255,.12);filter:blur(8px)}
.ps-hero-grid{position:relative;z-index:1;display:grid;gap:24px;grid-template-columns:minmax(0,1.4fr) minmax(260px,340px);align-items:end}
.ps-pill{display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(14px)}
.ps-dot{width:10px;height:10px;border-radius:50%;background:#b59bff;box-shadow:0 0 0 6px rgba(181,155,255,.18)}
.ps-hero-title{margin:18px 0 10px;color:#fff;font-size:clamp(2rem,5vw,3.4rem);line-height:1.02;text-shadow:0 10px 32px rgba(0,0,0,.18)}
.ps-hero-copy{margin:0;max-width:520px;color:rgba(255,255,255,.92);font-size:16px;line-height:1.7}
.ps-preview{justify-self:end;width:100%;max-width:320px;padding:20px;border-radius:28px;background:rgba(16,13,26,.26);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(14px);color:#fff}
.ps-preview-top{display:flex;align-items:center;gap:16px}
.ps-preview-meta{min-width:0}
.ps-overline{margin:0 0 6px;font-size:14px;opacity:.84}
.ps-preview-name{margin:0;font-size:20px;font-weight:700;overflow:hidden;text-overflow:ellipsis}
.ps-stat-grid,.ps-grid,.ps-fields{display:grid;gap:18px}
.ps-stat-grid{margin-top:18px;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ps-stat{padding:12px 14px;border-radius:18px;background:rgba(255,255,255,.08)}
.ps-stat-label{margin:0 0 6px;font-size:12px;opacity:.72}
.ps-stat-value{margin:0;font-weight:700}
.ps-banner,.ps-card,.ps-footer{border-radius:16px;background:var(--ps-surface);border:1px solid var(--ps-border);box-shadow:var(--ps-shadow)}
.ps-card{padding:28px clamp(20px,3vw,30px);transition:transform var(--theme-transition),box-shadow var(--theme-transition),border-color var(--theme-transition)}
.ps-card:hover{transform:translateY(-2px);border-color:rgba(181,155,255,.34)}
.ps-grid{grid-template-columns:minmax(0,1.2fr) minmax(320px,.8fr);align-items:start}
.ps-card-title{margin:0 0 8px;color:var(--ps-text);font-size:1.125rem;font-weight:600}
.ps-section-title{margin:0 0 8px;color:var(--ps-text);font-size:1.125rem;font-weight:600}
.ps-fields{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px}
.ps-field{display:grid;gap:8px}
.ps-field-span{grid-column:1 / -1}
.ps-label{color:var(--ps-text);font-size:14px;font-weight:600}
html[data-theme="dark"] .ps-label{color:#e5e7eb}
.ps-input,.ps-file{width:100%;box-sizing:border-box;padding:14px 16px;border-radius:12px;border:1px solid var(--ps-border);background:var(--ps-muted-surface);color:var(--ps-text);font-size:16px;outline:none;transition:border-color 200ms ease,box-shadow 200ms ease,background-color 200ms ease}
.ps-input::placeholder,.ps-file::file-selector-button{font-size:16px}
html[data-theme="dark"] .ps-input,html[data-theme="dark"] .ps-file{background:rgba(23,23,23,.6);border-color:rgba(38,38,38,.96)}
.ps-file{padding:12px}
.ps-input:hover,.ps-file:hover{border-color:rgba(181,155,255,.34)}
.ps-input-error{border-color:#e27891}
.ps-error{color:#c44f6e;font-size:13px}
.ps-info{padding:14px 16px;border-radius:18px;line-height:1.5}
.ps-danger{background:rgba(226,120,145,.12);border:1px solid rgba(226,120,145,.28);color:#b63d61}
.ps-success{background:rgba(108,214,168,.12);border:1px solid rgba(108,214,168,.24);color:var(--ps-success)}
.ps-segments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.ps-segment-active{border-color:#8c6fff;background:rgba(181,155,255,.16)}
.ps-media{display:grid;gap:16px}
.ps-media-preview{display:grid;place-items:center;min-height:180px;border-radius:16px;background:var(--ps-muted-surface);border:1px dashed var(--ps-border);margin-bottom:4px;overflow:hidden;transition:border-color var(--theme-transition),transform var(--theme-transition)}
.ps-media-preview:hover{transform:translateY(-1px);border-color:rgba(181,155,255,.34)}
.ps-avatar{width:132px;height:132px;border-radius:50%;object-fit:cover;box-shadow:var(--ps-card-shadow);animation:ps-fade-in var(--theme-transition-slow)}
.ps-avatar-fallback{width:132px;height:132px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,rgba(181,155,255,.95),rgba(140,111,255,.95));color:#fff;font-size:36px;font-weight:800}
.ps-theme-preview{width:100%;height:180px;object-fit:cover;animation:ps-fade-in var(--theme-transition-slow)}
.ps-footer{padding:20px 24px}
.ps-primary{border:none;border-radius:12px;padding:14px 16px;background:#4f46e5;color:#fff;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 12px 28px rgba(79,70,229,.22)}
.ps-primary:hover{background:#6366f1}
.ps-primary:disabled{opacity:.74;cursor:not-allowed}
.ps-loader{width:58px;height:58px;margin:0 auto 16px;border-radius:50%;border:4px solid rgba(181,155,255,.18);border-top-color:#8c6fff;animation:luma-spin .9s linear infinite}
.ps-subgrid{display:grid;gap:18px}
.ps-plan-pill{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:rgba(181,155,255,.16);border:1px solid rgba(181,155,255,.24);color:#8c6fff;font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
.ps-plan-pill-premium{background:linear-gradient(135deg,rgba(244,211,108,.22),rgba(217,168,60,.16));border-color:rgba(217,168,60,.3);color:#916500}
.ps-plan-list{margin:0;padding:0;list-style:none;display:grid;gap:10px}
.ps-plan-item{display:flex;gap:10px;color:var(--ps-muted);line-height:1.5}
.ps-plan-item strong{color:#8c6fff}
.ps-readonly{display:flex;align-items:center;min-height:52px;padding:14px 16px;border-radius:16px;border:1px solid var(--ps-border);background:var(--ps-muted-surface);color:var(--ps-text)}
.ps-divider{height:1px;background:var(--ps-border);opacity:.7}
.ps-danger-action{background:rgba(226,120,145,.12);border-color:rgba(226,120,145,.28);color:#b63d61}
@keyframes ps-fade-in{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:scale(1)}}
@keyframes luma-spin{to{transform:rotate(360deg)}}
@media (max-width:960px){.ps-hero-grid,.ps-grid{grid-template-columns:1fr}.ps-preview{justify-self:stretch;max-width:none}}
@media (max-width:767px){.ps-page{padding:32px 16px 48px}}
@media (min-width:768px){.ps-page{padding-left:32px;padding-right:32px}}
@media (prefers-reduced-motion:reduce){.ps-link,.ps-secondary,.ps-segment,.ps-danger-action,.ps-primary,.ps-card,.ps-input,.ps-file,.ps-media-preview,.ps-avatar,.ps-theme-preview{transition:none;animation:none}}
`;

function emptyForm(): FormValues {
  return {
    username: "",
    display_name: "",
    timezone: "",
    theme_mode: "light",
    phone_number: "",
    birthday: "",
  };
}

function normalizeThemeMode(value: string | null): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

function normalizeSubscriptionStatus(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "premium" || normalized === "active" ? "premium" : "free";
}

export default function ProfileSettingsPage() {
  const { refreshUser, logout } = useAuth();
  const { themeMode: activeThemeMode } = useTheme();
  const [profile, setProfile] = useState<AuthUser | null>(null);
  const [formValues, setFormValues] = useState<FormValues>(emptyForm);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [themeImageFile, setThemeImageFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [themePreview, setThemePreview] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [removeThemeImage, setRemoveThemeImage] = useState(false);

  function syncForm(nextProfile: AuthUser) {
    setFormValues({
      username: nextProfile.username,
      display_name: nextProfile.display_name ?? "",
      timezone: nextProfile.timezone ?? "",
      theme_mode: normalizeThemeMode(nextProfile.theme_mode),
      phone_number: nextProfile.phone_number ?? "",
      birthday: nextProfile.birthday ?? "",
    });
  }

  async function loadProfile() {
    setLoading(true);
    setPageError("");

    try {
      const response = await api.get<AuthUser>("/me/profile");
      setProfile(response.data);
      syncForm(response.data);
    } catch (error) {
      setPageError(
        getApiErrorMessage(error, "Unable to load your profile settings."),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProfile();
  }, []);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreview(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  useEffect(() => {
    if (!themeImageFile) {
      setThemePreview(null);
      return;
    }
    const url = URL.createObjectURL(themeImageFile);
    setThemePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [themeImageFile]);

  useEffect(() => {
    setFormValues((currentValues) =>
      currentValues.theme_mode === activeThemeMode
        ? currentValues
        : {
            ...currentValues,
            theme_mode: activeThemeMode,
          },
    );
  }, [activeThemeMode]);

  const shownAvatar = removeAvatar ? null : avatarPreview ?? profile?.avatar_url ?? null;
  const shownThemeImage = removeThemeImage
    ? null
    : themePreview ?? profile?.custom_theme_image_url ?? null;
  const themeMode = formValues.theme_mode;
  const vars = useMemo<CSSProperties>(
    () =>
      ({
        "--ps-surface":
          themeMode === "dark" ? "rgba(23, 19, 39, 0.92)" : "rgba(255, 255, 255, 0.92)",
        "--ps-muted-surface":
          themeMode === "dark" ? "rgba(31, 25, 53, 0.94)" : "rgba(248, 245, 255, 0.96)",
        "--ps-soft":
          themeMode === "dark" ? "rgba(19, 16, 33, 0.72)" : "rgba(255, 255, 255, 0.62)",
        "--ps-border":
          themeMode === "dark" ? "rgba(181, 155, 255, 0.22)" : "rgba(181, 155, 255, 0.24)",
        "--ps-text": themeMode === "dark" ? "#f6f2ff" : "#1d1730",
        "--ps-muted": themeMode === "dark" ? "#c8bedf" : "#6a6284",
        "--ps-success": themeMode === "dark" ? "#9bf0c8" : "#1d7d58",
        "--ps-shadow":
          themeMode === "dark"
            ? "0 28px 90px rgba(0, 0, 0, 0.3)"
            : "0 28px 90px rgba(55, 38, 98, 0.14)",
        "--ps-card-shadow":
          themeMode === "dark"
            ? "0 18px 44px rgba(0, 0, 0, 0.2)"
            : "0 18px 44px rgba(72, 53, 121, 0.12)",
        "--ps-hero-overlay":
          themeMode === "dark"
            ? "linear-gradient(135deg, rgba(15, 12, 24, 0.44), rgba(36, 28, 60, 0.86))"
            : "linear-gradient(135deg, rgba(255, 255, 255, 0.28), rgba(84, 63, 145, 0.62))",
        "--ps-hero-fallback":
          themeMode === "dark"
            ? "linear-gradient(135deg, rgba(90, 66, 161, 0.96), rgba(27, 20, 46, 0.98))"
            : "linear-gradient(135deg, rgba(181, 155, 255, 0.92), rgba(140, 111, 255, 0.96))",
      }) as CSSProperties,
    [themeMode],
  );

  function setField<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    setFormValues((current) => ({ ...current, [field]: value }));
    setFormErrors((current) => ({ ...current, [field]: undefined }));
    setPageError("");
    setSuccessMessage("");
  }

  function validateImage(file: File) {
    return FILE_TYPES.includes(file.type);
  }

  function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!validateImage(file)) {
      setPageError("Avatar must be a JPG, PNG, or WebP image.");
      return;
    }
    setPageError("");
    setAvatarFile(file);
    setRemoveAvatar(false);
    setSuccessMessage("");
  }

  function handleThemeImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!validateImage(file)) {
      setPageError("Theme image must be a JPG, PNG, or WebP image.");
      return;
    }
    setPageError("");
    setThemeImageFile(file);
    setRemoveThemeImage(false);
    setSuccessMessage("");
  }

  function validateForm() {
    if (!profile) return false;
    const errors: FormErrors = {};
    const username = formValues.username.trim();
    const displayName = formValues.display_name.trim();

    if (!username) {
      errors.username = "Username is required.";
    } else if (username.length < 3) {
      errors.username = "Username must be at least 3 characters.";
    } else if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      errors.username =
        "Username can only contain letters, numbers, and underscores.";
    }

    if (displayName && displayName.length < 2) {
      errors.display_name = "Display name must be at least 2 characters.";
    }

    if (!displayName && profile.display_name) {
      errors.display_name =
        "Display name cannot be cleared with the current backend.";
    }

    if (formValues.phone_number.trim().length > 32) {
      errors.phone_number = "Phone number must be 32 characters or fewer.";
    }

    if (formValues.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(formValues.birthday)) {
      errors.birthday = "Birthday must use the YYYY-MM-DD format.";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !validateForm()) return;

    setSaving(true);
    setPageError("");
    setSuccessMessage("");

    try {
      const username = formValues.username.trim();
      if (username !== profile.username) {
        await api.put("/me/username", { new_username: username });
      }

      await api.put("/me/profile", {
        display_name: formValues.display_name.trim() || undefined,
        timezone: formValues.timezone.trim(),
        theme_mode: formValues.theme_mode,
        phone_number: formValues.phone_number.trim(),
        birthday: formValues.birthday,
      });

      if (removeAvatar && profile.avatar_url) {
        await api.delete("/me/avatar");
      } else if (avatarFile) {
        const data = new FormData();
        data.append("file", avatarFile);
        await api.post("/me/avatar", data);
      }

      if (removeThemeImage && profile.custom_theme_image_url) {
        await api.delete("/me/theme-image");
      } else if (themeImageFile) {
        const data = new FormData();
        data.append("file", themeImageFile);
        await api.post("/me/theme-image", data);
      }

      const refreshed = await refreshUser();
      if (refreshed) {
        setProfile(refreshed);
        syncForm(refreshed);
      } else {
        await loadProfile();
      }

      setAvatarFile(null);
      setThemeImageFile(null);
      setRemoveAvatar(false);
      setRemoveThemeImage(false);
      setSuccessMessage("Profile settings saved successfully.");
    } catch (error) {
      setPageError(
        getApiErrorMessage(error, "Unable to save your profile settings."),
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PageSkeleton variant="settings" />;

  if (!profile) {
    return (
      <ApiErrorBoundary
        fullPage
        title="Settings unavailable"
        error={pageError || "We couldn't load your settings."}
        onRetry={() => {
          void loadProfile();
        }}
        secondaryHref="/dashboard"
        secondaryLabel="Back to dashboard"
      />
    );
  }

  const previewName = formValues.display_name.trim() || formValues.username.trim();
  const subscriptionStatus = normalizeSubscriptionStatus(profile.subscription_status);
  const isPremium = subscriptionStatus === "premium";

  return (
    <>
      <style>{styles}</style>
      <div
        className="ps-page max-w-full w-full px-4 sm:px-6 md:px-8 lg:px-0"
        style={vars}
      >
        <div className="ps-wrap max-w-full w-full px-4 sm:px-6 md:px-8 lg:px-0">
          <header className="ps-header flex-col md:flex-row">
            <div>
              <span className="ps-chip">Settings</span>
              <h1 className="ps-title">Shape your private Luma workspace</h1>
              <p className="ps-subtitle">
                Manage your account, theme, plan, avatar, and sign-out flow in one place.
              </p>
            </div>
            <div className="ps-actions flex-col md:flex-row">
              <Link className="ps-link" to="/dashboard">
                Back to dashboard
              </Link>
            </div>
          </header>

          {pageError ? <div className="ps-info ps-danger">{pageError}</div> : null}
          {successMessage ? (
            <div className="ps-info ps-success">{successMessage}</div>
          ) : null}

          <form className="ps-form" onSubmit={handleSave}>
            <section
              className="ps-hero"
              style={{
                backgroundImage: shownThemeImage
                  ? `var(--ps-hero-overlay), url(${shownThemeImage})`
                  : "var(--ps-hero-fallback)",
              }}
            >
              <div className="ps-hero-grid">
                <div>
                  <span className="ps-pill">
                    <span className="ps-dot" />
                    {themeMode === "dark" ? "Dark theme preview" : "Light theme preview"}
                  </span>
                  <h2 className="ps-hero-title">{previewName}</h2>
                  <p className="ps-hero-copy">
                    Preview your workspace before you save changes to account details, theme, and media.
                  </p>
                </div>

                <div className="ps-preview">
                  <div className="ps-preview-top">
                    {shownAvatar ? (
                      <img
                        className="ps-avatar"
                        src={shownAvatar}
                        alt={`${previewName} avatar preview`}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="ps-avatar-fallback">
                        {getUsernameAvatarLetter(formValues.username.trim() || profile.username)}
                      </div>
                    )}
                    <div className="ps-preview-meta">
                      <p className="ps-overline">Workspace username</p>
                      <p className="ps-preview-name">
                        {formValues.username.trim() || profile.username}
                      </p>
                    </div>
                  </div>

                  <div className="ps-stat-grid">
                    <div className="ps-stat">
                      <p className="ps-stat-label">Timezone</p>
                      <p className="ps-stat-value">
                        {formValues.timezone.trim() || "Not set"}
                      </p>
                    </div>
                    <div className="ps-stat">
                      <p className="ps-stat-label">Plan</p>
                      <p className="ps-stat-value">
                        {isPremium ? "Luma Pro" : "Free"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <div className="ps-grid">
              <section className="ps-card">
                <h2 className="ps-card-title">Account info</h2>
                <p className="ps-copy" style={{ marginBottom: 24 }}>
                  Update the core details that shape your private learning workspace.
                </p>

                <div className="ps-fields">
                  <label className="ps-field ps-field-span">
                    <span className="ps-label">Email</span>
                    <div className="ps-readonly">{profile.email}</div>
                    <span className="ps-help">
                      Your email is managed with your sign-in credentials and stays read-only here.
                    </span>
                  </label>

                  <label className="ps-field">
                    <span className="ps-label">Username</span>
                    <input
                      className={`ps-input w-full dark:bg-neutral-900/60 dark:border-neutral-800${formErrors.username ? " ps-input-error" : ""}`}
                      type="text"
                      autoComplete="username"
                      value={formValues.username}
                      onChange={(event) => setField("username", event.target.value)}
                      placeholder="username"
                    />
                    {formErrors.username ? (
                      <span className="ps-error">{formErrors.username}</span>
                    ) : (
                      <span className="ps-help">
                        Choose the name you use across your private workspace.
                      </span>
                    )}
                  </label>

                  <label className="ps-field">
                    <span className="ps-label">Display name</span>
                    <input
                      className={`ps-input w-full dark:bg-neutral-900/60 dark:border-neutral-800${formErrors.display_name ? " ps-input-error" : ""}`}
                      type="text"
                      value={formValues.display_name}
                      onChange={(event) => setField("display_name", event.target.value)}
                      placeholder="Name for your workspace"
                    />
                    {formErrors.display_name ? (
                      <span className="ps-error">{formErrors.display_name}</span>
                    ) : (
                      <span className="ps-help">
                        A calm name for your dashboard, settings, and study tools.
                      </span>
                    )}
                  </label>

                  <label className="ps-field">
                    <span className="ps-label">Timezone</span>
                    <input
                      className="ps-input w-full dark:bg-neutral-900/60 dark:border-neutral-800"
                      type="text"
                      list="luma-timezones"
                      value={formValues.timezone}
                      onChange={(event) => setField("timezone", event.target.value)}
                      placeholder="America/Chicago"
                    />
                    <datalist id="luma-timezones">
                      {TIMEZONES.map((timezone) => (
                        <option key={timezone} value={timezone} />
                      ))}
                    </datalist>
                    <span className="ps-help">Used to keep schedules and study timing aligned.</span>
                  </label>

                  <label className="ps-field">
                    <span className="ps-label">Phone number</span>
                    <input
                      className={`ps-input w-full dark:bg-neutral-900/60 dark:border-neutral-800${formErrors.phone_number ? " ps-input-error" : ""}`}
                      type="tel"
                      autoComplete="tel"
                      value={formValues.phone_number}
                      onChange={(event) => setField("phone_number", event.target.value)}
                      placeholder="+1 (555) 123-4567"
                    />
                    {formErrors.phone_number ? (
                      <span className="ps-error">{formErrors.phone_number}</span>
                    ) : null}
                  </label>

                  <label className="ps-field">
                    <span className="ps-label">Birthday</span>
                    <input
                      className={`ps-input w-full dark:bg-neutral-900/60 dark:border-neutral-800${formErrors.birthday ? " ps-input-error" : ""}`}
                      type="date"
                      value={formValues.birthday}
                      onChange={(event) => setField("birthday", event.target.value)}
                    />
                    {formErrors.birthday ? (
                      <span className="ps-error">{formErrors.birthday}</span>
                    ) : null}
                  </label>
                </div>
              </section>

              <aside className="ps-stack">
                <section className="ps-card">
                  <h2 className="ps-section-title">Subscription status</h2>
                  <p className="ps-copy" style={{ marginBottom: 18 }}>
                    See which features are available in your workspace right now.
                  </p>
                  <div className="ps-subgrid">
                    <span
                      className={`ps-plan-pill${
                        isPremium ? " ps-plan-pill-premium" : ""
                      }`}
                    >
                      {isPremium ? "Luma Pro" : "Free plan"}
                    </span>
                    <ul className="ps-plan-list">
                      <li className="ps-plan-item">
                        <strong>+</strong>
                        <span>Theme controls, settings, and private workspace management</span>
                      </li>
                      <li className="ps-plan-item">
                        <strong>+</strong>
                        <span>
                          {isPremium
                            ? "Premium study tools and AI features are unlocked."
                            : "Upgrade whenever you're ready for premium study tools and higher limits."}
                        </span>
                      </li>
                    </ul>
                    <div className="ps-inline flex-col md:flex-row">
                      <Link
                        className={`${isPremium ? "ps-link" : "ps-primary"} w-full md:w-auto`}
                        to={isPremium ? "/pro" : "/subscribe"}
                      >
                        {isPremium ? "View Pro benefits" : "Upgrade to Luma Pro"}
                      </Link>
                    </div>
                  </div>
                </section>

                <section className="ps-card">
                  <h2 className="ps-section-title">Manage avatar</h2>
                  <p className="ps-copy" style={{ marginBottom: 18 }}>
                    Upload a fresh image or keep the clean letter avatar tied to your username.
                  </p>
                    <div className="ps-media max-w-full w-full px-4 sm:px-6 md:px-8 lg:px-0">
                    <div className="ps-media-preview">
                      {shownAvatar ? (
                        <img
                          className="ps-avatar"
                          src={shownAvatar}
                          alt="Avatar preview"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div className="ps-avatar-fallback">
                          {getUsernameAvatarLetter(formValues.username.trim() || profile.username)}
                        </div>
                      )}
                    </div>
                    <span className="ps-help">
                      If you do nothing here, Luma keeps your default letter avatar.
                    </span>
                      <input
                        className="ps-file w-full dark:bg-neutral-900/60 dark:border-neutral-800"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleAvatarChange}
                    />
                      <div className="ps-inline flex-col md:flex-row">
                      <button
                          className="ps-secondary w-full md:w-auto"
                        type="button"
                        onClick={() => {
                          setAvatarFile(null);
                          setRemoveAvatar(Boolean(profile.avatar_url));
                          setSuccessMessage("");
                        }}
                      >
                        Remove avatar
                      </button>
                      <button
                          className="ps-secondary w-full md:w-auto"
                        type="button"
                        onClick={() => {
                          setAvatarFile(null);
                          setRemoveAvatar(false);
                          setSuccessMessage("");
                        }}
                      >
                        Reset avatar changes
                      </button>
                    </div>
                  </div>
                </section>

                <section className="ps-card">
                  <h2 className="ps-section-title">Theme selection</h2>
                  <p className="ps-copy" style={{ marginBottom: 18 }}>
                    Choose your workspace mode and stage an optional theme image.
                  </p>
                  <div className="ps-subgrid" style={{ marginBottom: 18 }}>
                    <div className="ps-segments">
                      {(["light", "dark"] as ThemeMode[]).map((mode) => (
                        <button
                          key={mode}
                          className={`ps-segment${
                            formValues.theme_mode === mode ? " ps-segment-active" : ""
                          }`}
                          type="button"
                          onClick={() => setField("theme_mode", mode)}
                        >
                          {mode === "light" ? "Light" : "Dark"}
                        </button>
                      ))}
                    </div>
                    <span className="ps-help">
                      Save when you're ready and your theme mode will update across Luma.
                    </span>
                  </div>
                    <div className="ps-media max-w-full w-full px-4 sm:px-6 md:px-8 lg:px-0">
                    <div className="ps-media-preview">
                      {shownThemeImage ? (
                        <img
                          className="ps-theme-preview"
                          src={shownThemeImage}
                          alt="Theme preview"
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <p className="ps-copy" style={{ padding: "0 20px", textAlign: "center" }}>
                          No theme image selected. The Lavender-Mist gradient will be used.
                        </p>
                      )}
                    </div>
                      <input
                        className="ps-file w-full dark:bg-neutral-900/60 dark:border-neutral-800"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleThemeImageChange}
                    />
                      <div className="ps-inline flex-col md:flex-row">
                      <button
                          className="ps-secondary w-full md:w-auto"
                        type="button"
                        onClick={() => {
                          setThemeImageFile(null);
                          setRemoveThemeImage(Boolean(profile.custom_theme_image_url));
                          setSuccessMessage("");
                        }}
                      >
                        Delete theme image
                      </button>
                      <button
                          className="ps-secondary w-full md:w-auto"
                        type="button"
                        onClick={() => {
                          setThemeImageFile(null);
                          setRemoveThemeImage(false);
                          setSuccessMessage("");
                        }}
                      >
                        Reset theme changes
                      </button>
                    </div>
                  </div>
                </section>

                <section className="ps-card">
                  <h2 className="ps-section-title">Danger zone</h2>
                  <p className="ps-copy" style={{ marginBottom: 18 }}>
                    Need a clean exit? You can log out without changing anything you've saved here.
                  </p>
                    <div className="ps-inline flex-col md:flex-row">
                      <button
                        className="ps-danger-action w-full md:w-auto"
                        type="button"
                        onClick={logout}
                      >
                      Log out
                    </button>
                  </div>
                </section>
              </aside>
            </div>

                <footer className="ps-footer flex-col md:flex-row">
              <p className="ps-copy" style={{ maxWidth: 640 }}>
                Saving applies your account, avatar, and theme changes together so the whole workspace stays in sync.
              </p>
                  <button className="ps-primary w-full md:w-auto" type="submit" disabled={saving}>
                {saving ? "Saving changes..." : "Save changes"}
              </button>
            </footer>
          </form>
        </div>
      </div>
    </>
  );
}
