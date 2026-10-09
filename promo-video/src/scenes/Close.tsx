import { C, Headline, Mark, Reveal, Stage, useLayout } from "../design";

export const Close = () => {
  const { wide, margin } = useLayout();
  return (
    <Stage dark brand={false}>
      <Reveal
        style={{
          position: "absolute",
          top: wide ? 114 : 174,
          left: margin,
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: 23,
          letterSpacing: 2.5,
          color: "#A9C3B2",
        }}
      >
        <Mark size={46} />
        INTRODUCING
      </Reveal>
      <div
        style={{ position: "absolute", left: margin, top: wide ? 260 : 354 }}
      >
        <Reveal delay={0.2}>
          <Headline dark size={wide ? 170 : 140}>
            Say the
            <br />
            Word<span style={{ color: C.green }}>.</span>
          </Headline>
        </Reveal>
        <Reveal
          delay={0.65}
          style={{ fontSize: wide ? 43 : 43, color: "#B6C8BC", marginTop: 42 }}
        >
          Think it. Say it. Keep going.
        </Reveal>
      </div>
      {wide && (
        <Reveal
          delay={0.5}
          style={{
            position: "absolute",
            right: 200,
            top: 340,
            width: 280,
            height: 280,
            borderRadius: 72,
            background: "#1C3023",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid #335540",
            boxShadow: "0 25px 100px #00000033",
          }}
        >
          <Mark size={196} live />
        </Reveal>
      )}
      <Reveal
        delay={1.25}
        style={{ position: "absolute", left: margin, bottom: wide ? 144 : 267 }}
      >
        <div
          style={{
            fontSize: wide ? 42 : 43,
            color: C.green,
            fontWeight: 550,
            marginBottom: 19,
          }}
        >
          Explore the early preview ↗
        </div>
        <div
          style={{
            fontSize: wide ? 28 : 27,
            color: "#C2CFC6",
            letterSpacing: 0.1,
          }}
        >
          github.com/yravinderkumar33/whisper-flow
        </div>
      </Reveal>
      <Reveal
        delay={1.6}
        style={{
          position: "absolute",
          left: margin,
          bottom: wide ? 62 : 120,
          color: "#8DA597",
          fontSize: wide ? 24 : 24,
        }}
      >
        Open source · macOS 14+ · Apple Silicon
      </Reveal>
    </Stage>
  );
};
