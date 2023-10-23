import { BlockProverExecutionData } from "../prover/block/BlockProvable";

import { TransitioningProtocolModule } from "./TransitioningProtocolModule";

export abstract class ProvableTransactionHook<Config> extends TransitioningProtocolModule<Config> {
  public abstract onTransaction(executionData: BlockProverExecutionData): void;
}
