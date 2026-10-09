import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const C = {
  ink: "#171C1A",
  paper: "#F5F4EE",
  white: "#FFFFFF",
  mute: "#858C87",
  green: "#3DDC84",
  pale: "#DDF5E6",
  dark: "#101A15",
  line: "#D8DED7",
};
export const font =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';
export const ease = {
  easing: Easing.bezier(0.16, 1, 0.3, 1),
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};
export function useLayout() {
  const { width, height, fps } = useVideoConfig();
  return {
    width,
    height,
    fps,
    wide: width > height,
    margin: width > height ? 112 : 84,
  };
}

export const Mark = ({
  size = 46,
  color = C.green,
  live = false,
}: {
  size?: number;
  color?: string;
  live?: boolean;
}) => {
  const frame = useCurrentFrame();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      {[20, 35, 46, 35, 20].map((h, i) => {
        const v = live
          ? h * (0.68 + 0.32 * Math.sin(frame * 0.23 + i * 1.7) ** 2)
          : h;
        return (
          <rect
            key={i}
            x={9 + i * 10}
            y={32 - v / 2}
            width="6"
            height={v}
            rx="3"
            fill={color}
          />
        );
      })}
    </svg>
  );
};

export const Lock = ({
  size = 56,
  color = C.green,
}: {
  size?: number;
  color?: string;
}) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <path d="M19 29V20a13 13 0 0 1 26 0v9" stroke={color} strokeWidth="4" />
    <rect
      x="12"
      y="28"
      width="40"
      height="29"
      rx="8"
      stroke={color}
      strokeWidth="4"
    />
    <circle cx="32" cy="41" r="3" fill={color} />
    <path d="M32 42v7" stroke={color} strokeWidth="3" />
  </svg>
);

export const Brand = ({ dark = false }: { dark?: boolean }) => {
  const { margin, wide } = useLayout();
  return (
    <div
      style={{
        position: "absolute",
        left: margin,
        right: margin,
        top: wide ? 58 : 76,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: wide ? 31 : 29,
          fontWeight: 650,
          letterSpacing: -1,
          color: dark ? C.paper : C.ink,
        }}
      >
        <Mark size={39} color={dark ? C.green : C.ink} />
        Say the Word
      </div>
      <div
        style={{
          fontSize: 20,
          letterSpacing: 2,
          color: dark ? "#A7B7AC" : "#657267",
        }}
      >
        FOR MAC
      </div>
    </div>
  );
};

export const Stage = ({
  children,
  dark = false,
  bg,
  brand = true,
}: {
  children: React.ReactNode;
  dark?: boolean;
  bg?: string;
  brand?: boolean;
}) => (
  <AbsoluteFill
    style={{
      background: bg ?? (dark ? C.dark : C.paper),
      color: dark ? C.paper : C.ink,
      fontFamily: font,
      overflow: "hidden",
    }}
  >
    {dark && (
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at 80% 70%, rgba(61,220,132,0.08), transparent 64%)",
        }}
      />
    )}
    {brand && <Brand dark={dark} />}
    {children}
  </AbsoluteFill>
);

export const Reveal = ({
  children,
  delay = 0,
  style = {},
}: {
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        opacity: interpolate(
          frame,
          [delay * fps, (delay + 0.48) * fps],
          [0, 1],
          ease,
        ),
        translate: `0px ${interpolate(frame, [delay * fps, (delay + 0.7) * fps], [34, 0], ease)}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Eyebrow = ({
  children,
  dark = false,
}: {
  children: React.ReactNode;
  dark?: boolean;
}) => (
  <div
    style={{
      fontSize: 23,
      fontWeight: 600,
      letterSpacing: 3,
      color: dark ? "#91BAA0" : "#647269",
      textTransform: "uppercase",
      marginBottom: 26,
    }}
  >
    {children}
  </div>
);

export const Key = ({
  pressed = false,
  size = 132,
}: {
  pressed?: boolean;
  size?: number;
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.21,
      background: pressed ? "#CBF3DB" : "#FAFAF7",
      color: C.ink,
      border: "2px solid " + (pressed ? "#3BAF6D" : "#CBD0C9"),
      boxShadow: pressed
        ? "0 3px 0 #A4CCB2, 0 12px 30px #15201912"
        : "0 10px 0 #BDC5BA, 0 25px 50px #15201915",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: size * 0.38,
      fontWeight: 500,
      translate: pressed ? "0px 7px" : "0px 0px",
    }}
  >
    fn
  </div>
);

export const Pill = ({
  listening = true,
  handsFree = false,
  processing = false,
  scale = 1,
}: {
  listening?: boolean;
  handsFree?: boolean;
  processing?: boolean;
  scale?: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        height: 66,
        minWidth: handsFree ? 260 : 124,
        background: "#161618",
        borderRadius: 40,
        border: "2px solid #515753",
        boxShadow: "0 12px 25px #00000026",
        padding: "0 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        scale,
        color: "white",
      }}
    >
      {processing ? (
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: "50%",
            border: "3px solid #ffffff44",
            borderTopColor: "white",
            rotate: `${frame * 16}deg`,
          }}
        />
      ) : (
        <Mark
          size={50}
          live={listening}
          color={listening ? C.green : "#7C827E"}
        />
      )}
      {handsFree && (
        <>
          <span style={{ fontSize: 25, fontVariantNumeric: "tabular-nums" }}>
            0:
            {Math.max(0, Math.floor(frame / fps - 1.25))
              .toString()
              .padStart(2, "0")}
          </span>
          <div
            style={{
              width: 17,
              height: 17,
              background: "#E5E8E5",
              borderRadius: 4,
            }}
          />
        </>
      )}
    </div>
  );
};

export const Headline = ({
  children,
  dark = false,
  size,
  style,
}: {
  children: React.ReactNode;
  dark?: boolean;
  size?: number;
  style?: React.CSSProperties;
}) => {
  const { wide } = useLayout();
  return (
    <div
      style={{
        fontSize: size ?? (wide ? 116 : 92),
        fontWeight: 650,
        lineHeight: 1.01,
        letterSpacing: wide ? -4 : -3,
        color: dark ? C.paper : C.ink,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
