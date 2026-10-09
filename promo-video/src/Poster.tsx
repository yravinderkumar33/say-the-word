import { C, Headline, Mark, Stage, useLayout } from "./design";

export const Poster = () => {
  const { wide, margin } = useLayout();
  return (
    <Stage dark brand={false}>
      <div
        style={{
          position: "absolute",
          left: margin,
          top: wide ? 90 : 137,
          fontSize: 28,
          letterSpacing: 2,
          color: "#A9C3B2",
        }}
      >
        PRIVATE DICTATION FOR MAC
      </div>
      <div
        style={{ position: "absolute", left: margin, top: wide ? 273 : 346 }}
      >
        <Headline dark size={wide ? 170 : 144}>
          Say the
          <br />
          Word<span style={{ color: C.green }}>.</span>
        </Headline>
        <div
          style={{ marginTop: 46, fontSize: wide ? 47 : 45, color: "#BDCFC3" }}
        >
          Less typing. More thinking.
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: wide ? 208 : 104,
          top: wide ? 330 : 955,
          width: wide ? 290 : 148,
          height: wide ? 290 : 148,
          borderRadius: wide ? 70 : 40,
          background: "#213C2B",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Mark size={wide ? 210 : 104} />
      </div>
      <div
        style={{
          position: "absolute",
          left: margin,
          bottom: wide ? 116 : 182,
          fontSize: wide ? 31 : 29,
          lineHeight: 1.5,
          color: "#A7C1AF",
        }}
      >
        Hold a key. Speak.
        <br />
        Your words stay on your Mac.
      </div>
    </Stage>
  );
};
