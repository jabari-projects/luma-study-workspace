import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  STUDY_TOOLS,
  type StudyTool,
} from "../features/study/studyTools";
import { useAuth } from "../context/AuthContext";
import { getUsernameAvatarLetter } from "../utils/avatar";
import StudyToolPanel from "./StudyToolPanel";
import ThemeToggle from "./ThemeToggle";
import UpgradeModal from "./UpgradeModal";
import LumaStar from "../assets/luma-star.png";

const navbarStyles = `
  .luma-navbar {
    position: sticky;
    top: 0;
    z-index: 950;
    padding: 16px 20px 0;
  }

  .luma-navbar__wrap {
    max-width: 1180px;
    margin: 0 auto;
    display: grid;
    gap: 12px;
  }

  .luma-navbar__shell {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 18px;
    border-radius: 24px;
    background: var(--surface-glass);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    backdrop-filter: blur(18px);
  }

  html[data-theme="dark"] .luma-navbar__shell {
    background: var(--surface-glass);
  }

  .luma-navbar__brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    color: var(--foreground);
    font-size: 1.2rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    white-space: nowrap;
  }

  .luma-navbar__brandMark {
    width: 34px;
    height: 34px;
    transition: transform 180ms ease, filter 180ms ease;
  }

  .luma-navbar__brandMark:hover {
    transform: scale(1.08);
    filter: brightness(1.15);
  }

  .luma-navbar__brandText {
    font-weight: 800;
    font-size: 1.25rem;
    letter-spacing: -0.03em;
    color: var(--foreground);
    display: inline-flex;
    align-items: center;
  }

  .luma-navbar__desktopLinks {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1 1 auto;
    justify-content: center;
  }

  .luma-navbar__link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 42px;
    padding: 0 14px;
    border-radius: 14px;
    text-decoration: none;
    color: var(--foreground-muted);
    font-weight: 700;
    transition: background-color 220ms ease, color 220ms ease, box-shadow 220ms ease;
  }

  .luma-navbar__link:hover,
  .luma-navbar__link:focus-visible {
    background: var(--surface-tint-soft);
    color: var(--foreground);
    outline: none;
  }

  .luma-navbar__link--active {
    background: var(--gradient-accent);
    color: var(--text-inverse);
    box-shadow: var(--shadow-accent);
  }

  .luma-navbar__studyMenu {
    position: relative;
  }

  .luma-navbar__studyTrigger,
  .luma-navbar__mobileStudyTrigger {
    border: 1px solid transparent;
    background: transparent;
  }

  .luma-navbar__studyTrigger.is-open {
    background: var(--gradient-accent);
    color: var(--text-inverse);
    box-shadow: var(--shadow-accent);
  }

  .luma-navbar__studyDropdown {
    position: absolute;
    top: calc(100% + 10px);
    left: 50%;
    transform: translateX(-50%);
    width: min(340px, 90vw);
    display: grid;
  }

  .luma-navbar__actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .luma-navbar__themeDesktop,
  .luma-navbar__themeMobile {
    display: inline-flex;
  }

  .luma-navbar__menuButton,
  .luma-navbar__avatarButton {
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    border-radius: 16px;
    cursor: pointer;
    box-shadow: var(--shadow);
  }

  .luma-navbar__menuButton {
    display: none;
    width: 46px;
    height: 46px;
    font-size: 1.15rem;
    align-items: center;
    justify-content: center;
  }

  .luma-navbar__avatarMenu {
    position: relative;
  }

  .luma-navbar__avatarButton {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 46px;
    padding: 6px 8px 6px 6px;
  }

  .luma-navbar__avatarImage,
  .luma-navbar__avatarFallback {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .luma-navbar__avatarImage {
    object-fit: cover;
  }

  .luma-navbar__avatarFallback {
    display: grid;
    place-items: center;
    background: var(--gradient-accent);
    color: var(--text-inverse);
    font-size: 0.95rem;
    font-weight: 800;
  }

  .luma-navbar__avatarMeta {
    display: grid;
    min-width: 0;
    text-align: left;
  }

  .luma-navbar__avatarNameRow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .luma-navbar__avatarName {
    color: var(--foreground);
    font-size: 0.92rem;
    font-weight: 700;
    line-height: 1.15;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .luma-navbar__planBadge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 800;
    background: var(--surface-tint-soft);
    color: var(--foreground-muted);
    border: 1px solid var(--border);
  }

  .luma-navbar__planBadge.is-premium {
    background: var(--premium-gradient);
    color: var(--premium-text);
    border-color: var(--premium-border);
  }

  .luma-navbar__avatarEmail {
    color: var(--foreground-muted);
    font-size: 0.76rem;
    line-height: 1.2;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .luma-navbar__avatarChevron {
    color: var(--foreground-muted);
    font-size: 0.8rem;
  }

  .luma-navbar__dropdown {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    width: min(260px, 84vw);
    padding: 10px;
    border-radius: 20px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
  }

  .luma-navbar__dropdownHeader {
    padding: 10px 12px 12px;
  }

  .luma-navbar__dropdownLabel {
    margin: 0 0 4px;
    color: var(--foreground);
    font-size: 0.92rem;
    font-weight: 700;
    line-height: 1.2;
  }

  .luma-navbar__dropdownEmail {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 0.78rem;
    line-height: 1.45;
    word-break: break-word;
  }

  .luma-navbar__dropdownDivider {
    height: 1px;
    margin: 4px 0 8px;
    background: var(--border);
  }

  .luma-navbar__dropdownAction {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 11px 12px;
    border: none;
    border-radius: 14px;
    background: transparent;
    color: var(--foreground);
    text-decoration: none;
    font-size: 0.92rem;
    font-weight: 700;
    cursor: pointer;
  }

  .luma-navbar__dropdownAction:hover,
  .luma-navbar__dropdownAction:focus-visible {
    background: var(--surface-tint-soft);
    outline: none;
  }

  .luma-navbar__mobilePanel {
    display: none;
    padding: 16px;
    border-radius: 24px;
    background: var(--surface-glass);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    backdrop-filter: blur(18px);
  }

  html[data-theme="dark"] .luma-navbar__mobilePanel {
    background: var(--surface-glass);
  }

  .luma-navbar__mobileLinks {
    display: grid;
    gap: 10px;
  }

  .luma-navbar__mobileLink {
    min-height: 46px;
    justify-content: flex-start;
    padding: 0 14px;
  }

  .luma-navbar__mobileSection {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .luma-navbar__mobileFooter {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    display: grid;
    gap: 12px;
  }

  @media (max-width: 860px) {
    .luma-navbar {
      padding: 14px 16px 0;
    }

    .luma-navbar__shell {
      padding: 12px 14px;
    }

    .luma-navbar__desktopLinks,
    .luma-navbar__themeDesktop,
    .luma-navbar__avatarMeta,
    .luma-navbar__studyMenu {
      display: none;
    }

    .luma-navbar__menuButton {
      display: inline-flex;
    }

    .luma-navbar__mobilePanel {
      display: grid;
    }
  }
`;

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const studyMenuRef = useRef<HTMLDivElement | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [studyMenuOpen, setStudyMenuOpen] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [upgradeFeatureName, setUpgradeFeatureName] = useState(
    "Premium study tools",
  );

  useEffect(() => {
    setMobileOpen(false);
    setDropdownOpen(false);
    setStudyMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!dropdownRef.current?.contains(event.target as Node)) {
        setDropdownOpen(false);
      }

      if (!studyMenuRef.current?.contains(event.target as Node)) {
        setStudyMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDropdownOpen(false);
        setStudyMenuOpen(false);
        setMobileOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  if (!user) {
    return null;
  }

  const displayName = user.display_name || user.username;
  const isPremium = user.subscription_status === "premium";
  const studyTools = STUDY_TOOLS.filter((tool) => tool.premium);
  const navItems = [
    { to: "/dashboard", label: "Dashboard" },
    { to: "/search", label: "Search" },
    { to: "/settings", label: "Settings" },
  ];

  function openUpgradeModal(tool: StudyTool) {
    setUpgradeFeatureName(tool.label);
    setUpgradeModalOpen(true);
    setStudyMenuOpen(false);
    setMobileOpen(false);
  }

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <>
      <style>{navbarStyles}</style>

      <nav className="luma-navbar" aria-label="Global navigation">
        <div className="luma-navbar__wrap">
          <div className="luma-navbar__shell">
            <Link className="luma-navbar__brand" to="/dashboard">
              <img
                src={LumaStar}
                alt="Luma Star"
                className="luma-navbar__brandMark"
                style={{
                  borderRadius: 0,
                  background: "transparent",
                  boxShadow: "none",
                }}
              />
              <span className="luma-navbar__brandText">Luma</span>
            </Link>

            <div className="luma-navbar__desktopLinks">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `luma-navbar__link${isActive ? " luma-navbar__link--active" : ""}`
                  }
                >
                  {item.label}
                </NavLink>
              ))}

              <div className="luma-navbar__studyMenu" ref={studyMenuRef}>
                <button
                  type="button"
                  className={`luma-navbar__link luma-navbar__studyTrigger${
                    studyMenuOpen ? " is-open" : ""
                  }`}
                  onClick={() => {
                    setStudyMenuOpen((current) => !current);
                    setDropdownOpen(false);
                  }}
                  aria-expanded={studyMenuOpen}
                  aria-haspopup="menu"
                >
                  Study
                </button>

                {studyMenuOpen ? (
                  <div className="luma-navbar__studyDropdown" role="menu">
                    <StudyToolPanel
                      title="Study tools"
                      description="One focused place for every study tool. Premium tools stay visible here, and locked clicks open your upgrade path instead of navigating."
                      tools={studyTools}
                      isPremium={isPremium}
                      surface="navbar-study"
                      onLockedClick={openUpgradeModal}
                      onToolNavigate={() => {
                        setStudyMenuOpen(false);
                      }}
                      compact
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <div className="luma-navbar__actions">
              <div className="luma-navbar__themeDesktop">
                <ThemeToggle variant="inline" compact />
              </div>

              <div className="luma-navbar__avatarMenu" ref={dropdownRef}>
                <button
                  type="button"
                  className="luma-navbar__avatarButton"
                  onClick={() => {
                    setDropdownOpen((current) => !current);
                    setMobileOpen(false);
                    setStudyMenuOpen(false);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={dropdownOpen}
                >
                  {user.avatar_url ? (
                    <img
                      className="luma-navbar__avatarImage"
                      src={user.avatar_url}
                      alt={`${displayName} avatar`}
                    />
                  ) : (
                    <span className="luma-navbar__avatarFallback">
                      {getUsernameAvatarLetter(user.username)}
                    </span>
                  )}

                  <span className="luma-navbar__avatarMeta">
                    <span className="luma-navbar__avatarName">{displayName}</span>
                    <span className="luma-navbar__avatarHandle">
                      {isPremium ? "Premium workspace" : "Free workspace"}
                    </span>
                  </span>

                  <span className="luma-navbar__avatarChevron">
                    {dropdownOpen ? "^" : "v"}
                  </span>
                </button>

                {dropdownOpen ? (
                  <div className="luma-navbar__dropdown" role="menu">
                    <div className="luma-navbar__dropdownHeader">
                      <p className="luma-navbar__dropdownLabel">{displayName}</p>
                      <p className="luma-navbar__dropdownEmail">{user.email}</p>
                      <span className="luma-navbar__planBadge">
                        {isPremium ? "Premium" : "Free"}
                      </span>
                    </div>
                    <div className="luma-navbar__dropdownDivider" />
                    <Link
                      to="/settings"
                      className="luma-navbar__dropdownAction"
                      role="menuitem"
                    >
                      <span>Workspace Settings</span>
                      <span>Open</span>
                    </Link>
                    <button
                      type="button"
                      className="luma-navbar__dropdownAction"
                      onClick={handleLogout}
                      role="menuitem"
                    >
                      <span>Logout</span>
                      <span>Out</span>
                    </button>
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                className="luma-navbar__menuButton"
                onClick={() => {
                  setMobileOpen((current) => !current);
                  setDropdownOpen(false);
                  setStudyMenuOpen(false);
                }}
                aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
                aria-expanded={mobileOpen}
              >
                {mobileOpen ? "X" : "Menu"}
              </button>
            </div>
          </div>

          {mobileOpen ? (
            <div className="luma-navbar__mobilePanel">
              <div className="luma-navbar__mobileLinks">
                {navItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `luma-navbar__link luma-navbar__mobileLink${
                        isActive ? " luma-navbar__link--active" : ""
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>

              <div className="luma-navbar__mobileSection">
                <StudyToolPanel
                  title="Study tools"
                  description="The same focused study layout stays available on mobile, with Premium locks and upgrade prompts kept in place."
                  tools={studyTools}
                  isPremium={isPremium}
                  surface="mobile-study"
                  onLockedClick={openUpgradeModal}
                  onToolNavigate={() => {
                    setMobileOpen(false);
                  }}
                  compact
                />
              </div>

              <div className="luma-navbar__mobileFooter">
                <ThemeToggle variant="inline" compact />
                <button
                  type="button"
                  className="luma-navbar__dropdownAction"
                  onClick={handleLogout}
                >
                  <span>Logout</span>
                  <span>Out</span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </nav>

      <UpgradeModal
        open={upgradeModalOpen}
        onClose={() => {
          setUpgradeModalOpen(false);
        }}
        featureName={upgradeFeatureName}
      />
    </>
  );
}
