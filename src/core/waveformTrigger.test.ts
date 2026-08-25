import { describe, expect, it } from "vitest";
import {
  advanceWaveformTrigger,
  createArmedWaveformTriggerState,
  createIdleWaveformTriggerState,
  type WaveformTriggerConfig,
  type WaveformTriggerObservation,
} from "./waveformTrigger";

const RISING_CONFIG: WaveformTriggerConfig = {
  channelId: "channel-0",
  edge: "rising",
  threshold: 5,
};

function advance(
  observations: readonly WaveformTriggerObservation[],
  batchEndTimestampSeconds: number | null = observations.at(-1)?.timestampSeconds ?? null,
) {
  return advanceWaveformTrigger(
    createArmedWaveformTriggerState(RISING_CONFIG, 10),
    observations,
    batchEndTimestampSeconds,
  );
}

describe("waveformTrigger", () => {
  it("上升沿在跨批次达到阈值时只触发一次", () => {
    const first = advanceWaveformTrigger(
      createArmedWaveformTriggerState(RISING_CONFIG, 10),
      [{ timestampSeconds: 1, value: 4 }],
      1,
    );
    const second = advanceWaveformTrigger(
      first.state,
      [
        { timestampSeconds: 2, value: 5 },
        { timestampSeconds: 3, value: 3 },
        { timestampSeconds: 4, value: 8 },
      ],
      4,
    );

    expect(second.state).toMatchObject({
      phase: "triggered",
      triggerTimestampSeconds: 2,
      freezeTimestampSeconds: 7,
    });
    expect(second.shouldFreeze).toBe(false);
  });

  it("下降沿包含等于阈值的当前样本", () => {
    const state = createArmedWaveformTriggerState(
      { ...RISING_CONFIG, edge: "falling" },
      6,
    );
    const result = advanceWaveformTrigger(
      state,
      [
        { timestampSeconds: 1, value: 6 },
        { timestampSeconds: 2, value: 5 },
      ],
      2,
    );

    expect(result.state).toMatchObject({
      phase: "triggered",
      triggerTimestampSeconds: 2,
      freezeTimestampSeconds: 5,
    });
  });

  it("首个样本等于阈值时只建立基线", () => {
    const result = advance(
      [
        { timestampSeconds: 1, value: 5 },
        { timestampSeconds: 2, value: 6 },
      ],
      2,
    );

    expect(result.state.phase).toBe("armed");
  });

  it("gap 和非有限值会切断边沿比较", () => {
    const first = advanceWaveformTrigger(
      createArmedWaveformTriggerState(RISING_CONFIG, 10),
      [{ timestampSeconds: 1, value: 4 }],
      1,
    );
    const gap = advanceWaveformTrigger(
      first.state,
      [
        { timestampSeconds: 2, value: null },
        { timestampSeconds: 3, value: 8 },
        { timestampSeconds: 4, value: Number.NaN },
        { timestampSeconds: 5, value: 3 },
      ],
      5,
    );

    expect(gap.state.phase).toBe("armed");
    expect(gap.state.previousValue).toBe(3);
  });

  it("同批时间戳按帧顺序比较且忽略倒退样本", () => {
    const result = advance(
      [
        { timestampSeconds: 2, value: 4 },
        { timestampSeconds: 2, value: 8 },
        { timestampSeconds: 1, value: 4 },
        { timestampSeconds: 3, value: 5 },
      ],
      3,
    );

    expect(result.state).toMatchObject({
      phase: "triggered",
      triggerTimestampSeconds: 2,
    });
  });

  it("迟到 gap 不会清除较新的比较基线", () => {
    const result = advance(
      [
        { timestampSeconds: 10, value: 4 },
        { timestampSeconds: 9, value: null },
        { timestampSeconds: 11, value: 6 },
      ],
      11,
    );

    expect(result.state).toMatchObject({
      phase: "triggered",
      triggerTimestampSeconds: 11,
    });
  });

  it("gap 保留时间水位并拒绝后续倒退样本", () => {
    const result = advance(
      [
        { timestampSeconds: 10, value: 6 },
        { timestampSeconds: 11, value: null },
        { timestampSeconds: 9, value: 4 },
        { timestampSeconds: 12, value: 6 },
      ],
      12,
    );

    expect(result.state).toMatchObject({
      phase: "armed",
      previousTimestampSeconds: 12,
      previousValue: 6,
    });
  });

  it("到达后半窗时恰好请求一次冻结", () => {
    const triggered = advance(
      [
        { timestampSeconds: 1, value: 4 },
        { timestampSeconds: 2, value: 6 },
      ],
      2,
    );
    const beforeEnd = advanceWaveformTrigger(triggered.state, [], 6.999);
    const atEnd = advanceWaveformTrigger(beforeEnd.state, [], 7);
    const afterFrozen = advanceWaveformTrigger(atEnd.state, [], 8);

    expect(beforeEnd.state.phase).toBe("triggered");
    expect(beforeEnd.shouldFreeze).toBe(false);
    expect(atEnd.state.phase).toBe("frozen");
    expect(atEnd.shouldFreeze).toBe(true);
    expect(afterFrozen.state).toBe(atEnd.state);
    expect(afterFrozen.shouldFreeze).toBe(false);
  });

  it("空闲状态忽略样本并保持引用", () => {
    const state = createIdleWaveformTriggerState();
    const result = advanceWaveformTrigger(state, [{ timestampSeconds: 1, value: 9 }], 1);

    expect(result.state).toBe(state);
    expect(result.shouldFreeze).toBe(false);
  });

  it("拒绝非法通道、阈值和时间窗", () => {
    expect(() =>
      createArmedWaveformTriggerState({ ...RISING_CONFIG, channelId: "" }, 5),
    ).toThrow(/配置/);
    expect(() =>
      createArmedWaveformTriggerState({ ...RISING_CONFIG, threshold: Number.POSITIVE_INFINITY }, 5),
    ).toThrow(/配置/);
    expect(() => createArmedWaveformTriggerState(RISING_CONFIG, 0)).toThrow(/时间窗/);
  });
});
