type PageSkeletonProps = {
  variant: "dashboard" | "settings";
};

const styles = `
  .luma-skeleton {
    min-height: 100vh;
    padding: 16px;
  }

  .luma-skeleton__wrap {
    max-width: 1180px;
    margin: 0 auto;
    display: grid;
    gap: 16px;
  }

  .luma-skeleton__surface {
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--card);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .luma-skeleton__grid {
    display: grid;
    gap: 16px;
  }

  .luma-skeleton__grid--three {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }

  .luma-skeleton__grid--two {
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
    align-items: start;
  }

  .luma-skeleton__bar,
  .luma-skeleton__circle {
    position: relative;
    overflow: hidden;
    background: var(--surface-tint-soft);
  }

  .luma-skeleton__bar::after,
  .luma-skeleton__circle::after {
    content: "";
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(
      90deg,
      transparent,
      color-mix(in srgb, var(--text-inverse) 38%, transparent),
      transparent
    );
    animation: luma-skeleton-shimmer 1.4s infinite;
  }

  .luma-skeleton__bar {
    border-radius: 16px;
  }

  .luma-skeleton__circle {
    border-radius: 50%;
  }

  @keyframes luma-skeleton-shimmer {
    100% {
      transform: translateX(100%);
    }
  }

  @media (max-width: 960px) {
    .luma-skeleton__grid--two {
      grid-template-columns: 1fr;
    }
  }
`;

function Bar({
  width = "100%",
  height,
  radius,
}: {
  width?: string | number;
  height: number;
  radius?: number;
}) {
  return (
    <div
      className="luma-skeleton__bar"
      style={{
        width,
        height,
        borderRadius: radius,
      }}
      aria-hidden="true"
    />
  );
}

function Circle({ size }: { size: number }) {
  return (
    <div
      className="luma-skeleton__circle"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

function DashboardSkeleton() {
  return (
    <div className="luma-skeleton__wrap">
      <section
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Bar width={132} height={34} radius={999} />
          <Bar width={360} height={42} radius={18} />
          <Bar width={420} height={16} radius={12} />
        </div>
        <Bar width={120} height={48} radius={16} />
      </section>

      <section className="luma-skeleton__surface" style={{ minHeight: 320, padding: 16 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 24,
            alignItems: "end",
          }}
        >
          <div style={{ display: "grid", gap: 16 }}>
            <Bar width={180} height={38} radius={999} />
            <Bar width="72%" height={48} radius={18} />
            <Bar width="88%" height={16} radius={12} />
            <Bar width="76%" height={16} radius={12} />
          </div>

          <div
            style={{
              padding: 20,
              borderRadius: 16,
              border: "1px solid var(--border)",
              background: "var(--card)",
              display: "grid",
              gap: 18,
            }}
          >
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <Circle size={84} />
              <div style={{ display: "grid", gap: 10, flex: 1 }}>
                <Bar width="74%" height={14} radius={10} />
                <Bar width="94%" height={22} radius={12} />
              </div>
            </div>
            <div className="luma-skeleton__grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Bar height={68} radius={18} />
              <Bar height={68} radius={18} />
            </div>
          </div>
        </div>
      </section>

      <section className="luma-skeleton__grid luma-skeleton__grid--three">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="luma-skeleton__surface"
              style={{ padding: 16, display: "grid", gap: 16 }}
          >
            <Bar width={44} height={44} radius={14} />
            <Bar width="56%" height={20} radius={12} />
            <Bar width="92%" height={15} radius={12} />
            <Bar width="80%" height={15} radius={12} />
          </div>
        ))}
      </section>

      <section className="luma-skeleton__surface" style={{ padding: 16, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 10 }}>
            <Bar width={180} height={28} radius={14} />
            <Bar width={300} height={16} radius={12} />
          </div>
          <Bar width={180} height={34} radius={999} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12 }}>
          <Bar height={48} radius={16} />
          <Bar width={110} height={48} radius={16} />
        </div>
        <div className="luma-skeleton__grid luma-skeleton__grid--three">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 16,
                padding: 16,
                background: "var(--card)",
                display: "flex",
                gap: 14,
                alignItems: "center",
              }}
            >
              <Circle size={56} />
              <div style={{ display: "grid", gap: 8, flex: 1 }}>
                <Bar width="60%" height={18} radius={10} />
                <Bar width="40%" height={14} radius={10} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="luma-skeleton__wrap">
      <section
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "grid", gap: 12 }}>
          <Bar width={150} height={34} radius={999} />
          <Bar width={360} height={42} radius={18} />
          <Bar width={420} height={16} radius={12} />
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Bar width={148} height={48} radius={16} />
          <Bar width={150} height={48} radius={16} />
        </div>
      </section>

      <section className="luma-skeleton__surface" style={{ minHeight: 320, padding: 16 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 24,
            alignItems: "end",
          }}
        >
          <div style={{ display: "grid", gap: 16 }}>
            <Bar width={194} height={38} radius={999} />
            <Bar width="62%" height={48} radius={18} />
            <Bar width="86%" height={16} radius={12} />
            <Bar width="74%" height={16} radius={12} />
          </div>

          <div
            style={{
              padding: 20,
              borderRadius: 16,
              border: "1px solid var(--border)",
              background: "var(--card)",
              display: "grid",
              gap: 18,
            }}
          >
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <Circle size={88} />
              <div style={{ display: "grid", gap: 10, flex: 1 }}>
                <Bar width="62%" height={14} radius={10} />
                <Bar width="82%" height={22} radius={12} />
              </div>
            </div>
            <div className="luma-skeleton__grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Bar height={68} radius={18} />
              <Bar height={68} radius={18} />
            </div>
          </div>
        </div>
      </section>

      <section className="luma-skeleton__grid luma-skeleton__grid--two">
        <div className="luma-skeleton__surface" style={{ padding: 16, display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gap: 10 }}>
            <Bar width={210} height={28} radius={14} />
            <Bar width="88%" height={16} radius={12} />
          </div>
          <div className="luma-skeleton__grid luma-skeleton__grid--three">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} style={{ display: "grid", gap: 10 }}>
                <Bar width="44%" height={14} radius={10} />
                <Bar height={48} radius={16} />
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 24 }}>
          {[0, 1].map((index) => (
            <div
              key={index}
              className="luma-skeleton__surface"
              style={{ padding: 16, display: "grid", gap: 16 }}
            >
              <div style={{ display: "grid", gap: 10 }}>
                <Bar width={132} height={24} radius={14} />
                <Bar width="92%" height={16} radius={12} />
              </div>
              <Bar height={184} radius={24} />
              <Bar height={46} radius={16} />
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Bar width={164} height={44} radius={16} />
                <Bar width={178} height={44} radius={16} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="luma-skeleton__surface" style={{ padding: 16, display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <Bar width="56%" height={18} radius={12} />
        <Bar width={148} height={50} radius={18} />
      </section>
    </div>
  );
}

export default function PageSkeleton({ variant }: PageSkeletonProps) {
  return (
    <>
      <style>{styles}</style>

      <div className="luma-skeleton" aria-busy="true" aria-live="polite">
        {variant === "dashboard" ? <DashboardSkeleton /> : null}
        {variant === "settings" ? <SettingsSkeleton /> : null}
      </div>
    </>
  );
}
