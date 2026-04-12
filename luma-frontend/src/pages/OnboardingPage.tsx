import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { api, getApiErrorMessage, type AuthUser } from "../api/api";
import { useAuth } from "../context/AuthContext";
import {
  clearDevFlowOnboardingStep,
  recordDevFlowOnboardingStep,
} from "../context/DevFlowTestingContext";
import {
  useTheme,
  type ThemeMode,
} from "../context/ThemeContext";
import { trackOnboardingCompleted } from "../lib/analytics";
import { getUsernameAvatarLetter } from "../utils/avatar";

const onboardingStyles = `
  @keyframes luma-onboarding-enter {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes luma-onboarding-avatar-fade {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes luma-onboarding-checkmark-draw {
    from {
      stroke-dashoffset: 36;
    }
    to {
      stroke-dashoffset: 0;
    }
  }

  @keyframes luma-onboarding-pop {
    from {
      opacity: 0;
      transform: scale(0.92);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .luma-onboarding {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 32px 20px 48px;
  }

  .luma-onboarding__shell {
    width: min(1120px, 100%);
    display: grid;
    grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
    gap: 24px;
    align-items: stretch;
  }

  .luma-onboarding__intro,
  .luma-onboarding__panel {
    border-radius: 32px;
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .luma-onboarding__intro {
    position: relative;
    background:
      radial-gradient(circle at top left, rgba(255, 255, 255, 0.4), transparent 44%),
      linear-gradient(160deg, rgba(181, 155, 255, 0.3), rgba(255, 255, 255, 0.82));
    padding: 32px 28px;
  }

  html[data-theme="dark"] .luma-onboarding__intro {
    background:
      radial-gradient(circle at top left, rgba(255, 255, 255, 0.08), transparent 42%),
      linear-gradient(160deg, rgba(140, 111, 255, 0.28), rgba(23, 19, 39, 0.92));
  }

  .luma-onboarding__eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.74);
    color: var(--accent-strong);
    font-size: 0.78rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  html[data-theme="dark"] .luma-onboarding__eyebrow {
    background: rgba(23, 19, 39, 0.84);
  }

  .luma-onboarding__title {
    margin: 22px 0 14px;
    color: var(--foreground);
    font-size: clamp(2.2rem, 4vw, 3.6rem);
    line-height: 1.02;
    letter-spacing: -0.04em;
  }

  .luma-onboarding__subtitle {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 1rem;
    line-height: 1.7;
  }

  .luma-onboarding__featureList {
    display: grid;
    gap: 14px;
    margin-top: 30px;
  }

  .luma-onboarding__feature {
    display: grid;
    gap: 6px;
    padding: 20px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.74);
    border: 1px solid rgba(181, 155, 255, 0.2);
  }

  html[data-theme="dark"] .luma-onboarding__feature {
    background: rgba(23, 19, 39, 0.82);
  }

  .luma-onboarding__featureTitle {
    margin: 0;
    color: var(--foreground);
    font-size: 0.98rem;
    font-weight: 700;
  }

  .luma-onboarding__featureCopy {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .luma-onboarding__panel {
    background: rgba(255, 255, 255, 0.9);
    backdrop-filter: blur(18px);
    padding: 32px;
  }

  html[data-theme="dark"] .luma-onboarding__panel {
    background: rgba(17, 14, 29, 0.9);
  }

  .luma-onboarding__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }

  .luma-onboarding__metaLabel {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.86rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .luma-onboarding__metaTitle {
    margin: 8px 0 0;
    color: var(--foreground);
    font-size: clamp(1.75rem, 3vw, 2.5rem);
    line-height: 1.08;
    letter-spacing: -0.03em;
  }

  .luma-onboarding__progressText {
    color: var(--foreground-muted);
    font-size: 0.9rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .luma-onboarding__progressTrack {
    width: 100%;
    height: 10px;
    margin-bottom: 22px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.14);
    overflow: hidden;
  }

  .luma-onboarding__progressFill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    box-shadow: 0 10px 22px rgba(140, 111, 255, 0.24);
    transition: width 260ms ease;
  }

  .luma-onboarding__steps {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 28px;
  }

  .luma-onboarding__step {
    display: grid;
    gap: 6px;
    padding: 14px 14px 16px;
    border-radius: 18px;
    border: 1px solid var(--border);
    background: var(--card-muted);
  }

  .luma-onboarding__step--active {
    background: rgba(181, 155, 255, 0.16);
    border-color: rgba(181, 155, 255, 0.3);
  }

  .luma-onboarding__step--complete {
    background: rgba(181, 155, 255, 0.12);
  }

  .luma-onboarding__stepNumber {
    color: var(--accent-strong);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .luma-onboarding__stepLabel {
    color: var(--foreground);
    font-size: 0.92rem;
    font-weight: 700;
  }

  .luma-onboarding__copy {
    margin: 0 0 24px;
    color: var(--foreground-muted);
    line-height: 1.7;
  }

  .luma-onboarding__form {
    display: grid;
    gap: 24px;
  }

  .luma-onboarding__stepPane {
    display: grid;
    gap: 24px;
    animation: luma-onboarding-enter 260ms ease;
  }

  .luma-onboarding__field {
    display: grid;
    gap: 8px;
  }

  .luma-onboarding__fieldLabel {
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 600;
  }

  html[data-theme="dark"] .luma-onboarding__fieldLabel {
    color: #e5e7eb;
  }

  .luma-onboarding__input {
    width: 100%;
    padding: 14px 16px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--card-muted);
    color: var(--foreground);
    font-size: 1rem;
    outline: none;
    transition:
      border-color 200ms ease,
      box-shadow 200ms ease,
      background-color 200ms ease;
  }

  html[data-theme="dark"] .luma-onboarding__input {
    background: rgba(23, 23, 23, 0.6);
    border-color: rgba(38, 38, 38, 0.96);
  }

  .luma-onboarding__input:focus {
    border-color: rgba(99, 102, 241, 0.44);
    box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.16);
  }

  .luma-onboarding__choiceGrid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 14px;
  }

  .luma-onboarding__choice {
    display: grid;
    gap: 10px;
    padding: 20px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card-muted);
    color: var(--foreground);
    text-align: left;
    cursor: pointer;
    transition:
      transform 180ms ease,
      border-color 180ms ease,
      box-shadow 180ms ease,
      background 180ms ease;
  }

  .luma-onboarding__choice:hover {
    transform: translateY(-2px);
    border-color: rgba(181, 155, 255, 0.34);
    box-shadow: 0 16px 34px rgba(140, 111, 255, 0.1);
  }

  .luma-onboarding__choice--selected {
    border-color: rgba(181, 155, 255, 0.42);
    background: rgba(181, 155, 255, 0.15);
    box-shadow: 0 18px 40px rgba(140, 111, 255, 0.12);
  }

  .luma-onboarding__choiceTitle {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }

  .luma-onboarding__choiceCopy {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .luma-onboarding__swatch {
    width: 100%;
    height: 68px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.28);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.32);
  }

  .luma-onboarding__uploader {
    display: grid;
    gap: 16px;
  }

  .luma-onboarding__avatarWrap {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }

  .luma-onboarding__avatarPreview,
  .luma-onboarding__avatarFallback {
    width: 96px;
    height: 96px;
    border-radius: 28px;
    flex-shrink: 0;
  }

  .luma-onboarding__avatarPreview {
    object-fit: cover;
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    animation: luma-onboarding-avatar-fade 220ms ease;
  }

  .luma-onboarding__avatarFallback {
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    color: #ffffff;
    font-size: 2rem;
    font-weight: 800;
    box-shadow: 0 18px 40px rgba(140, 111, 255, 0.2);
  }

  .luma-onboarding__uploadCard {
    flex: 1 1 280px;
    display: grid;
    gap: 12px;
    padding: 20px;
    border-radius: 16px;
    border: 1px dashed rgba(181, 155, 255, 0.42);
    background: rgba(181, 155, 255, 0.08);
  }

  .luma-onboarding__uploadHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-onboarding__uploadButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 46px;
    padding: 0 18px;
    border-radius: 12px;
    border: none;
    background: #4f46e5;
    color: #ffffff;
    font-weight: 700;
    cursor: pointer;
    width: fit-content;
    transition:
      transform 180ms ease,
      box-shadow 180ms ease,
      filter 180ms ease;
  }

  .luma-onboarding__uploadButton:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 28px rgba(79, 70, 229, 0.22);
    background: #6366f1;
  }

  .luma-onboarding__uploadInput {
    display: none;
  }

  .luma-onboarding__uploadActions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-onboarding__help {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .luma-onboarding__optionalLabel {
    margin: 0;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(181, 155, 255, 0.12);
    border: 1px solid rgba(181, 155, 255, 0.18);
    color: var(--foreground-muted);
    font-size: 0.82rem;
    font-weight: 600;
    line-height: 1.4;
  }

  .luma-onboarding__error {
    padding: 14px 16px;
    border-radius: 16px;
    background: rgba(226, 120, 145, 0.12);
    border: 1px solid rgba(226, 120, 145, 0.28);
    color: #b63d61;
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .luma-onboarding__notice {
    padding: 14px 16px;
    border-radius: 16px;
    background: rgba(181, 155, 255, 0.12);
    border: 1px solid rgba(181, 155, 255, 0.24);
    color: var(--foreground);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .luma-onboarding__actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .luma-onboarding__actionsMeta {
    color: var(--foreground-muted);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .luma-onboarding__submit {
    min-width: 180px;
    min-height: 54px;
    padding: 0 24px;
    border: none;
    border-radius: 12px;
    background: #4f46e5;
    color: #ffffff;
    font-size: 1rem;
    font-weight: 800;
    cursor: pointer;
    box-shadow: 0 18px 38px rgba(140, 111, 255, 0.26);
    transition:
      transform 180ms ease,
      box-shadow 180ms ease,
      filter 180ms ease;
  }

  .luma-onboarding__submit:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 14px 30px rgba(79, 70, 229, 0.24);
    background: #6366f1;
  }

  .luma-onboarding__submit:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  .luma-onboarding__actionButtons {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .luma-onboarding__skipButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 46px;
    padding: 0 18px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--card-muted);
    color: var(--foreground);
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      color 200ms ease,
      transform 200ms ease,
      background-color 200ms ease,
      border-color 200ms ease,
      box-shadow 200ms ease;
  }

  .luma-onboarding__skipButton:hover:not(:disabled) {
    transform: translateY(-1px);
    background: rgba(181, 155, 255, 0.12);
    border-color: rgba(99, 102, 241, 0.22);
    box-shadow: 0 10px 24px rgba(99, 102, 241, 0.12);
  }

  .luma-onboarding__skipButton:focus-visible {
    outline: none;
    border-color: rgba(99, 102, 241, 0.44);
    box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.16);
  }

  .luma-onboarding__skipButton:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  .luma-onboarding__success {
    min-height: 420px;
    display: grid;
    place-items: center;
    padding: 18px 0;
  }

  .luma-onboarding__successCard {
    width: min(420px, 100%);
    display: grid;
    justify-items: center;
    gap: 14px;
    text-align: center;
    animation: luma-onboarding-pop 260ms ease;
  }

  .luma-onboarding__successIcon {
    width: 88px;
    height: 88px;
    display: grid;
    place-items: center;
    border-radius: 28px;
    background: linear-gradient(135deg, var(--accent-strong), var(--accent));
    box-shadow: 0 18px 40px rgba(140, 111, 255, 0.22);
  }

  .luma-onboarding__successCheck {
    width: 34px;
    height: 34px;
  }

  .luma-onboarding__successCheck path {
    stroke-dasharray: 36;
    stroke-dashoffset: 36;
    animation: luma-onboarding-checkmark-draw 420ms 120ms ease forwards;
  }

  .luma-onboarding__successTitle {
    margin: 0;
    color: var(--foreground);
    font-size: clamp(1.8rem, 3vw, 2.3rem);
    letter-spacing: -0.03em;
  }

  .luma-onboarding__successCopy {
    margin: 0;
    max-width: 320px;
    color: var(--foreground-muted);
    line-height: 1.7;
  }

  @media (max-width: 1366px) {
    .luma-onboarding {
      padding: 24px 20px 36px;
    }

    .luma-onboarding__shell {
      width: min(1040px, 100%);
      grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
      gap: 20px;
    }

    .luma-onboarding__intro,
    .luma-onboarding__panel {
      padding: 24px;
    }

    .luma-onboarding__featureList,
    .luma-onboarding__form,
    .luma-onboarding__stepPane {
      gap: 20px;
    }

    .luma-onboarding__copy {
      margin-bottom: 20px;
    }

    .luma-onboarding__title,
    .luma-onboarding__subtitle {
      max-width: 420px;
    }

    .luma-onboarding__uploadCard {
      flex-basis: 240px;
      max-width: 420px;
      padding: 18px;
    }
  }

  @media (max-width: 1024px) {
    .luma-onboarding__shell {
      grid-template-columns: 1fr;
      gap: 16px;
    }

    .luma-onboarding__intro,
    .luma-onboarding__panel {
      padding: 24px;
    }

    .luma-onboarding__avatarWrap {
      align-items: flex-start;
    }

    .luma-onboarding__uploadCard {
      width: 100%;
      max-width: 100%;
      flex-basis: auto;
    }

    .luma-onboarding__actions {
      position: sticky;
      bottom: 0;
      padding-top: 16px;
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0),
        rgba(255, 255, 255, 0.95) 18%
      );
      z-index: 2;
    }

    html[data-theme="dark"] .luma-onboarding__actions {
      background: linear-gradient(
        180deg,
        rgba(17, 14, 29, 0),
        rgba(17, 14, 29, 0.96) 18%
      );
    }
  }

  @media (max-width: 768px) {
    .luma-onboarding {
      padding: 20px 16px 28px;
    }

    .luma-onboarding__shell {
      gap: 16px;
    }

    .luma-onboarding__panel,
    .luma-onboarding__intro {
      padding: 20px;
      border-radius: 26px;
    }

    .luma-onboarding__meta {
      align-items: flex-start;
      flex-direction: column;
    }

    .luma-onboarding__form,
    .luma-onboarding__stepPane,
    .luma-onboarding__featureList {
      gap: 16px;
    }

    .luma-onboarding__steps {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 20px;
    }

    .luma-onboarding__avatarWrap {
      justify-content: center;
      gap: 16px;
    }

    .luma-onboarding__actions {
      gap: 12px;
      padding-top: 12px;
    }

    .luma-onboarding__actionsMeta {
      width: 100%;
    }

    .luma-onboarding__actionButtons {
      width: 100%;
      justify-content: stretch;
    }

    .luma-onboarding__submit {
      min-height: 50px;
      width: 100%;
    }
  }

  @media (max-width: 640px) {
    .luma-onboarding {
      padding: 20px 14px 24px;
    }

    .luma-onboarding__panel,
    .luma-onboarding__intro {
      padding: 20px 16px;
      border-radius: 22px;
    }

    .luma-onboarding__feature,
    .luma-onboarding__choice,
    .luma-onboarding__uploadCard {
      padding: 16px;
    }

    .luma-onboarding__steps {
      grid-template-columns: 1fr;
    }

    .luma-onboarding__step {
      padding: 12px 12px 14px;
    }

    .luma-onboarding__title {
      margin: 18px 0 12px;
    }

    .luma-onboarding__copy {
      margin-bottom: 16px;
    }

    .luma-onboarding__avatarPreview,
    .luma-onboarding__avatarFallback {
      width: 88px;
      height: 88px;
    }

    .luma-onboarding__uploadButton {
      width: 100%;
    }

    .luma-onboarding__uploadActions {
      width: 100%;
    }

    .luma-onboarding__skipButton {
      width: 100%;
    }
  }
`;

function normalizeThemeMode(value: string | null | undefined): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

function getInitialStep(user: AuthUser | null) {
  if (!user) {
    return 1;
  }

  if (user.display_name == null) {
    return 1;
  }

  if (user.theme_mode == null) {
    return 2;
  }

  return 4;
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const { user, refreshUser } = useAuth();
  const {
    themeMode,
    themeColor,
    setThemeColor,
    themeColorOptions,
  } = useTheme();
  const [currentStep, setCurrentStep] = useState(() => getInitialStep(user));
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [selectedThemeMode, setSelectedThemeMode] = useState<ThemeMode>(
    user?.theme_mode ? normalizeThemeMode(user.theme_mode) : themeMode,
  );
  const [selectedThemeColor, setSelectedThemeColor] = useState(themeColor);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    user?.avatar_url ?? null,
  );
  const [avatarInitial, setAvatarInitial] = useState(() =>
    getUsernameAvatarLetter(user?.username ?? ""),
  );
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);

  useEffect(() => {
    if (user?.display_name && !displayName.trim()) {
      setDisplayName(user.display_name);
    }
  }, [displayName, user?.display_name]);

  useEffect(() => {
    if (user?.theme_mode) {
      setSelectedThemeMode(normalizeThemeMode(user.theme_mode));
    }
  }, [user?.theme_mode]);

  useEffect(() => {
    setAvatarUrl(user?.avatar_url ?? null);
    setAvatarInitial(getUsernameAvatarLetter(user?.username ?? ""));
  }, [user?.avatar_url, user?.username]);

  useEffect(() => {
    recordDevFlowOnboardingStep(currentStep);
  }, [currentStep]);

  useEffect(
    () => () => {
      clearDevFlowOnboardingStep();
    },
    [],
  );

  useEffect(() => {
    setSelectedThemeColor(themeColor);
  }, [themeColor]);

  useEffect(() => {
    if (!avatarFile) {
      setAvatarPreviewUrl(null);
      return;
    }

    const nextObjectUrl = URL.createObjectURL(avatarFile);
    setAvatarPreviewUrl(nextObjectUrl);

    return () => {
      URL.revokeObjectURL(nextObjectUrl);
    };
  }, [avatarFile]);

  const avatarPreview = avatarPreviewUrl ?? avatarUrl ?? user?.avatar_url ?? null;
  const stepSummaries = ["Name", "Theme", "Accent", "Avatar"];
  const totalSteps = stepSummaries.length;

  const canContinue = useMemo(() => {
    if (currentStep === 1) {
      const trimmedName = displayName.trim();
      return trimmedName.length >= 2 && trimmedName.length <= 50;
    }

    if (currentStep === 2) {
      return selectedThemeMode === "light" || selectedThemeMode === "dark";
    }

    if (currentStep === 3) {
      return selectedThemeColor.trim().length > 0;
    }

    return true;
  }, [currentStep, displayName, selectedThemeColor, selectedThemeMode]);

  async function submitProfile(values: {
    display_name?: string;
    theme_mode?: ThemeMode;
    avatar_url?: string | null;
  }) {
    const response = await api.put<AuthUser>("/me/profile", values);
    await refreshUser();
    return response.data;
  }

  async function completeOnboarding(withAvatarUpload: boolean) {
    trackOnboardingCompleted({
      subscriptionStatus: user?.subscription_status ?? null,
      metadata: {
        with_avatar_upload: withAvatarUpload,
        used_letter_avatar: !withAvatarUpload,
      },
    });
    setIsFinishing(true);
    await new Promise((resolve) => {
      window.setTimeout(resolve, 950);
    });
    navigate("/dashboard", { replace: true });
  }

  async function handleDisplayNameStep() {
    setNotice("");
    const trimmedName = displayName.trim();

    if (trimmedName.length < 2) {
      setError("Display name must be at least 2 characters.");
      return;
    }

    if (trimmedName.length > 50) {
      setError("Display name must be 50 characters or fewer.");
      return;
    }

    const refreshedUser = await submitProfile({
      display_name: trimmedName,
    });

    if (refreshedUser.theme_mode == null) {
      setCurrentStep(2);
      return;
    }

    setCurrentStep(3);
  }

  async function handleThemeModeStep() {
    setNotice("");
    await submitProfile({
      theme_mode: selectedThemeMode,
    });
    setCurrentStep(3);
  }

  async function handleAccentColorStep() {
    setNotice("");
    await submitProfile({
      theme_mode: selectedThemeMode,
    });

    await setThemeColor(selectedThemeColor);
    setCurrentStep(4);
  }

  async function handleAvatarStep() {
    setNotice("");

    if (
      avatarFile &&
      !["image/jpeg", "image/png", "image/webp"].includes(avatarFile.type)
    ) {
      setError("Only JPG, PNG, and WebP files are supported.");
      return;
    }

    if (!avatarFile) {
      await submitProfile({
        avatar_url: null,
      });
    } else {
      const formData = new FormData();
      formData.append("file", avatarFile);

      try {
        await api.post("/me/avatar", formData, {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        });
      } catch (uploadError) {
        console.warn("Avatar upload failed during onboarding:", uploadError);
        setNotice(
          "We couldn't upload that image right now, so Luma will keep your default letter avatar for now.",
        );
      }

      await refreshUser();
    }

    await completeOnboarding(Boolean(avatarFile));
  }

  async function handleSkip() {
    setError("");
    setNotice("");
    setIsSaving(true);

    try {
      setAvatarUrl(null);
      setAvatarInitial(getUsernameAvatarLetter(user?.username ?? ""));
      await submitProfile({
        avatar_url: null,
      });
      await completeOnboarding(false);
    } catch (skipError) {
      setError(getApiErrorMessage(skipError, "Unable to finish setup."));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSaving(true);

    try {
      if (currentStep === 1) {
        await handleDisplayNameStep();
      } else if (currentStep === 2) {
        await handleThemeModeStep();
      } else if (currentStep === 3) {
        await handleAccentColorStep();
      } else {
        await handleAvatarStep();
      }
    } catch (submitError) {
      setError(getApiErrorMessage(submitError, "Unable to save this step."));
    } finally {
      setIsSaving(false);
    }
  }

  function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setAvatarFile(file);
    setError("");
    setNotice("");
  }

  if (!user) {
    return null;
  }

  const stepContent =
    currentStep === 1 ? (
      <label className="luma-onboarding__field">
        <span className="luma-onboarding__fieldLabel">Display name</span>
        <input
          className="luma-onboarding__input w-full dark:bg-[#1a1a1a]/70 dark:border-neutral-800"
          type="text"
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value);
            setError("");
          }}
          placeholder={user.username}
          autoComplete="nickname"
          maxLength={50}
        />
      </label>
    ) : currentStep === 2 ? (
      <div className="luma-onboarding__field">
        <span className="luma-onboarding__fieldLabel">Theme mode</span>
        <div className="luma-onboarding__choiceGrid">
          {(["light", "dark"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`luma-onboarding__choice${
                selectedThemeMode === mode
                  ? " luma-onboarding__choice--selected"
                  : ""
              }`}
              onClick={() => {
                setSelectedThemeMode(mode);
                setError("");
              }}
            >
              <p className="luma-onboarding__choiceTitle">
                {mode === "light" ? "Light" : "Dark"}
              </p>
              <p className="luma-onboarding__choiceCopy">
                {mode === "light"
                  ? "Clean and airy for daytime focus."
                  : "Quiet contrast for late-night sessions."}
              </p>
            </button>
          ))}
        </div>
      </div>
    ) : currentStep === 3 ? (
      <div className="luma-onboarding__field">
        <span className="luma-onboarding__fieldLabel">Accent color</span>
        <div className="luma-onboarding__choiceGrid">
          {themeColorOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`luma-onboarding__choice${
                selectedThemeColor === option.value
                  ? " luma-onboarding__choice--selected"
                  : ""
              }`}
              onClick={() => {
                setSelectedThemeColor(option.value);
                setError("");
              }}
            >
              <div
                className="luma-onboarding__swatch"
                style={{ background: option.preview }}
                aria-hidden="true"
              />
              <p className="luma-onboarding__choiceTitle">{option.label}</p>
              <p className="luma-onboarding__choiceCopy">
                {option.value === "lavender-mist"
                  ? "Luma's signature calm, soft and polished."
                  : "A gentle alternate accent you can change later."}
              </p>
            </button>
          ))}
        </div>
      </div>
    ) : (
      <div className="luma-onboarding__uploader">
        <div className="luma-onboarding__avatarWrap mx-auto text-center md:text-left">
          {avatarPreview ? (
            <img
              className="luma-onboarding__avatarPreview mx-auto mt-4 mb-6"
              src={avatarPreview}
              alt={`${displayName || user.username} avatar preview`}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="luma-onboarding__avatarFallback mx-auto mt-4 mb-6">
              {avatarInitial}
            </div>
          )}

          <div className="luma-onboarding__uploadCard">
            <div className="luma-onboarding__uploadHeader">
              <p className="luma-onboarding__featureTitle">Upload your avatar</p>
              <p className="text-sm text-neutral-400 mt-1 luma-onboarding__optionalLabel">
                Optional
              </p>
            </div>
            <p className="luma-onboarding__help">
              Add an image now, or finish with your letter avatar and update it
              any time later.
            </p>
            <div className="luma-onboarding__uploadActions">
              <label className="luma-onboarding__uploadButton">
                <span>{avatarFile ? "Change image" : "Choose image"}</span>
                <input
                  className="luma-onboarding__uploadInput"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleAvatarChange}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  void handleSkip();
                }}
                className="luma-onboarding__skipButton"
                disabled={isSaving || isFinishing}
              >
                Skip
              </button>

              <style>
                {`
                  @media (max-width: 768px) {
                    .luma-onboarding__skipButton { width: 100%; }
                  }
                `}
              </style>
            </div>
            {avatarFile ? (
              <p className="luma-onboarding__help">Selected: {avatarFile.name}</p>
            ) : null}
          </div>
        </div>
      </div>
    );

  return (
    <>
      <style>{onboardingStyles}</style>

      <div className="luma-onboarding">
        <div className="luma-onboarding__shell">
          <aside className="luma-onboarding__intro">
            <span className="luma-onboarding__eyebrow">Luma Setup</span>
            <h1 className="luma-onboarding__title">
              Shape your workspace in a few calm steps.
            </h1>
            <p className="luma-onboarding__subtitle">
              A few quick choices, saved as you go, so Luma already feels like
              yours when you arrive.
            </p>

            <div className="luma-onboarding__featureList">
              <div className="luma-onboarding__feature">
                <p className="luma-onboarding__featureTitle">
                  Quietly personal
                </p>
                <p className="luma-onboarding__featureCopy">
                  Set your name and avatar so your workspace feels settled from
                  the start.
                </p>
              </div>

              <div className="luma-onboarding__feature">
                <p className="luma-onboarding__featureTitle">
                  Comfort first
                </p>
                <p className="luma-onboarding__featureCopy">
                  Choose the theme and accent that make studying feel calm and
                  clear.
                </p>
              </div>

              <div className="luma-onboarding__feature">
                <p className="luma-onboarding__featureTitle">
                  Ready for focus
                </p>
                <p className="luma-onboarding__featureCopy">
                  Finish here and you will land in your dashboard ready to
                  study, explore tools, and keep going.
                </p>
              </div>
            </div>
          </aside>

          <section className="luma-onboarding__panel">
            <div className="luma-onboarding__meta">
              <div>
                <p className="luma-onboarding__metaLabel">
                  Step {currentStep} of {totalSteps}
                </p>
                <h2 className="luma-onboarding__metaTitle">
                  {stepSummaries[currentStep - 1]}
                </h2>
              </div>

              <div className="luma-onboarding__progressText">
                {Math.round((currentStep / totalSteps) * 100)}% complete
              </div>
            </div>

            <div className="luma-onboarding__progressTrack" aria-hidden="true">
              <div
                className="luma-onboarding__progressFill"
                style={{ width: `${(currentStep / totalSteps) * 100}%` }}
              />
            </div>

            <div className="luma-onboarding__steps" aria-label="Onboarding steps">
              {stepSummaries.map((stepLabel, index) => {
                const stepNumber = index + 1;
                const isActive = currentStep === stepNumber;
                const isComplete = currentStep > stepNumber;

                return (
                  <div
                    key={stepLabel}
                    className={`luma-onboarding__step${
                      isActive ? " luma-onboarding__step--active" : ""
                    }${isComplete ? " luma-onboarding__step--complete" : ""}`}
                  >
                    <span className="luma-onboarding__stepNumber">
                      Step {stepNumber}
                    </span>
                    <span className="luma-onboarding__stepLabel">{stepLabel}</span>
                  </div>
                );
              })}
            </div>

            <p className="luma-onboarding__copy">
              {currentStep === 1
                ? "Choose the name you want to see across Luma."
                : currentStep === 2
                  ? "Pick the mood that feels best for everyday study."
                  : currentStep === 3
                    ? "Add a soft accent to make the space feel familiar."
                    : "Upload an avatar now, or finish with your default letter avatar."}
            </p>

            {isFinishing ? (
              <div className="luma-onboarding__success" aria-live="polite">
                <div className="luma-onboarding__successCard">
                  <div className="luma-onboarding__successIcon" aria-hidden="true">
                    <svg
                      className="luma-onboarding__successCheck"
                      viewBox="0 0 32 32"
                      fill="none"
                    >
                      <path
                        d="M7 16.5L13.2 22.2L25 10.5"
                        stroke="#ffffff"
                        strokeWidth="3.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <h3 className="luma-onboarding__successTitle">
                    Your workspace is ready.
                  </h3>
                  <p className="luma-onboarding__successCopy">
                    Taking you to the dashboard now so you can settle in and get
                    started.
                  </p>
                </div>
              </div>
            ) : (
              <form className="luma-onboarding__form" onSubmit={handleSubmit} noValidate>
                <div key={currentStep} className="luma-onboarding__stepPane">
                  {stepContent}
                </div>

                {error ? <div className="luma-onboarding__error">{error}</div> : null}
                {notice ? <div className="luma-onboarding__notice">{notice}</div> : null}

                <div className="luma-onboarding__actions">
                  <div className="luma-onboarding__actionsMeta">
                    {currentStep < totalSteps
                      ? "You can refine these choices later in Settings."
                      : "Finish now with an uploaded image or your default letter avatar."}
                  </div>

                  <div className="luma-onboarding__actionButtons w-full md:w-auto">
                    <button
                      className="luma-onboarding__submit w-full md:w-auto"
                      type="submit"
                      disabled={!canContinue || isSaving || isFinishing}
                    >
                      {isSaving
                        ? "Saving..."
                        : currentStep === totalSteps
                          ? "Finish setup"
                          : "Continue"}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
