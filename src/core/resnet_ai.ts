import type{ GameState } from '../types';

export interface PolicyValue {
  policy: number[]; // 361 维
  value: number;    // -1..1
}

export interface ResNetConfig {
  inputChannels: number;
  residualBlocks: number;
  boardSize: number;
}

export interface IResNetEvaluator {
  evaluate(state: GameState): Promise<PolicyValue>;
}

export class DummyResNetEvaluator implements IResNetEvaluator {
  async evaluate(_state: GameState): Promise<PolicyValue> {
    const size = 19 * 19;
    const policy = Array(size).fill(1 / size);
    return { policy, value: 0 };
  }
}
