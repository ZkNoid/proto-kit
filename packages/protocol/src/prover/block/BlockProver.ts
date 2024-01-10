/* eslint-disable max-lines */
import {
  Bool,
  Experimental,
  Field,
  type Proof,
  Provable,
  SelfProof,
  Struct,
} from "o1js";
import { container, inject, injectable, injectAll } from "tsyringe";
import {
  AreProofsEnabled,
  PlainZkProgram,
  provableMethod,
  WithZkProgrammable,
  ZkProgrammable,
} from "@proto-kit/common";

import { DefaultProvableHashList } from "../../utils/ProvableHashList";
import { MethodPublicOutput } from "../../model/MethodPublicOutput";
import { ProtocolModule } from "../../protocol/ProtocolModule";
import {
  StateTransitionProof,
  StateTransitionProverPublicInput,
  StateTransitionProverPublicOutput,
} from "../statetransition/StateTransitionProvable";
import { RuntimeTransaction } from "../../model/transaction/RuntimeTransaction";

import {
  BlockProvable,
  BlockProverExecutionData,
  BlockProverProof,
  BlockProverPublicInput,
  BlockProverPublicOutput,
} from "./BlockProvable";
import {
  ProvableStateTransition,
  StateTransition,
} from "../../model/StateTransition";
import { ProvableTransactionHook } from "../../protocol/ProvableTransactionHook";
import { RuntimeMethodExecutionContext } from "../../state/context/RuntimeMethodExecutionContext";
import { ProvableBlockHook } from "../../protocol/ProvableBlockHook";
import { NetworkState } from "../../model/network/NetworkState";
import { BlockTransactionPosition } from "./BlockTransactionPosition";
import {
  BlockHashMerkleTreeWitness,
  BlockHashTreeEntry,
} from "./acummulators/BlockHashMerkleTree";
import { ProtocolTransaction } from "../../model/transaction/ProtocolTransaction";

const errors = {
  stateProofNotStartingAtZero: () =>
    "StateProof not starting ST-commitment at zero",

  stateTransitionsHashNotEqual: () =>
    "StateTransition list commitments are not equal",

  propertyNotMatching: (propertyName: string) => `${propertyName} not matching`,

  stateRootNotMatching: (step: string) => `StateRoots not matching ${step}`,

  transactionsHashNotMatching: (step: string) =>
    `transactions hash not matching ${step}`,
};

// Should be equal to BlockProver.PublicInput and -Output
export interface BlockProverState {
  // The current state root of the block prover
  stateRoot: Field;

  /**
   * The current commitment of the transaction-list which
   * will at the end equal the bundle hash
   */
  transactionsHash: Field;

  /**
   * The network state which gives access to values such as blockHeight
   * This value is the same for the whole batch (L2 block)
   */
  networkStateHash: Field;

  blockHashRoot: Field;

  eternalTransactionsHash: Field;
}

const maxField = () => Field(Field.ORDER - 1n);

export class BlockProverProgrammable extends ZkProgrammable<
  BlockProverPublicInput,
  BlockProverPublicOutput
> {
  public constructor(
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    private readonly prover: BlockProver,
    public readonly stateTransitionProver: ZkProgrammable<
      StateTransitionProverPublicInput,
      StateTransitionProverPublicOutput
    >,
    public readonly runtime: ZkProgrammable<undefined, MethodPublicOutput>,
    private readonly transactionHooks: ProvableTransactionHook<unknown>[],
    private readonly blockHooks: ProvableBlockHook<unknown>[]
  ) {
    super();
  }

  public get appChain(): AreProofsEnabled | undefined {
    return this.prover.appChain;
  }

  /**
   * Applies and checks the two proofs and applies the corresponding state
   * changes to the given state
   *
   * @param state The from-state of the BlockProver
   * @param stateTransitionProof
   * @param appProof
   * @param executionData
   * @returns The new BlockProver-state to be used as public output
   */
  public applyTransaction(
    state: BlockProverState,
    stateTransitionProof: Proof<
      StateTransitionProverPublicInput,
      StateTransitionProverPublicOutput
    >,
    appProof: Proof<void, MethodPublicOutput>,
    executionData: BlockProverExecutionData
  ): BlockProverState {
    const { transaction, networkState } = executionData;

    appProof.verify();
    stateTransitionProof.verify();

    const stateTo = { ...state };

    // Checks for the stateTransitionProof and appProof matching
    stateTransitionProof.publicInput.stateTransitionsHash.assertEquals(
      Field(0),
      errors.stateProofNotStartingAtZero()
    );
    stateTransitionProof.publicInput.protocolTransitionsHash.assertEquals(
      Field(0),
      errors.stateProofNotStartingAtZero()
    );

    appProof.publicOutput.stateTransitionsHash.assertEquals(
      stateTransitionProof.publicOutput.stateTransitionsHash,
      errors.stateTransitionsHashNotEqual()
    );

    // Assert from state roots
    state.stateRoot.assertEquals(
      stateTransitionProof.publicInput.stateRoot,
      errors.propertyNotMatching("from state root")
    );
    state.stateRoot.assertEquals(
      stateTransitionProof.publicInput.protocolStateRoot,
      errors.propertyNotMatching("from protocol state root")
    );

    // Apply state if status success
    stateTo.stateRoot = Provable.if(
      appProof.publicOutput.status,
      stateTransitionProof.publicOutput.stateRoot,
      stateTransitionProof.publicOutput.protocolStateRoot
    );

    // Apply protocol state transitions
    this.assertProtocolTransitions(stateTransitionProof, executionData);

    // Check transaction signature
    transaction
      .validateSignature()
      .assertTrue("Transaction signature not valid");

    // Check transaction integrity against appProof
    const blockTransactionHash =
      RuntimeTransaction.fromProtocolTransaction(transaction).hash();

    blockTransactionHash.assertEquals(
      appProof.publicOutput.transactionHash,
      "Transactions provided in AppProof and BlockProof do not match"
    );

    // Check network state integrity against appProof
    state.networkStateHash.assertEquals(
      appProof.publicOutput.networkStateHash,
      "Network state does not match state used in AppProof"
    );
    state.networkStateHash.assertEquals(
      networkState.hash(),
      "Network state provided to BlockProver does not match the publicInput"
    );

    return stateTo;
  }

  // eslint-disable-next-line no-warning-comments, max-len
  // TODO How does this interact with the RuntimeMethodExecutionContext when executing runtimemethods?

  public assertProtocolTransitions(
    stateTransitionProof: Proof<
      StateTransitionProverPublicInput,
      StateTransitionProverPublicOutput
    >,
    executionData: BlockProverExecutionData
  ) {
    const executionContext = container.resolve(RuntimeMethodExecutionContext);
    executionContext.clear();

    // Setup context for potential calls to runtime methods.
    // This way they can use this.transaction etc. while still having provable
    // integrity between data
    executionContext.setup({
      transaction: RuntimeTransaction.fromProtocolTransaction(
        executionData.transaction
      ),

      networkState: executionData.networkState,
    });
    executionContext.beforeMethod("", "", []);

    this.transactionHooks.forEach((module) => {
      module.onTransaction(executionData);
    });

    executionContext.afterMethod();

    const { stateTransitions, status, statusMessage } =
      executionContext.current().result;

    status.assertTrue(statusMessage);

    const transitions = stateTransitions.map((transition) =>
      transition.toProvable()
    );

    const hashList = new DefaultProvableHashList(
      ProvableStateTransition,
      stateTransitionProof.publicInput.protocolTransitionsHash
    );

    transitions.forEach((transition) => {
      hashList.push(transition);
    });

    stateTransitionProof.publicOutput.protocolTransitionsHash.assertEquals(
      hashList.commitment,
      "ProtocolTransitionsHash not matching the generated protocol transitions"
    );
  }

  private executeBlockHooks(
    state: BlockProverState,
    inputNetworkState: NetworkState,
    type: "afterBlock" | "beforeBlock"
  ): {
    networkState: NetworkState;
    stateTransitions: StateTransition<unknown>[];
  } {
    const executionContext = container.resolve(RuntimeMethodExecutionContext);
    executionContext.clear();
    executionContext.beforeMethod("", "", []);

    const resultingNetworkState = this.blockHooks.reduce<NetworkState>(
      (networkState, blockHook) => {
        // Setup context for potential calls to runtime methods.
        // With the special case that we set the new networkstate for every hook
        // We also have to put in a dummy transaction for network.transaction
        executionContext.setup({
          transaction: RuntimeTransaction.dummy(),
          networkState,
        });

        if (type === "beforeBlock") {
          return blockHook.beforeBlock(networkState, state);
        } else if (type === "afterBlock") {
          return blockHook.afterBlock(networkState, state);
        } else {
          throw new Error("Unreachable");
        }
      },
      inputNetworkState
    );

    executionContext.afterMethod();

    const { stateTransitions, status, statusMessage } =
      executionContext.current().result;

    status.assertTrue(`Block hook call failed: ${statusMessage ?? "-"}`);

    return {
      networkState: resultingNetworkState,
      stateTransitions,
    };
  }

  private addTransactionToBundle(
    state: BlockProverState,
    transactionHash: Field
  ): BlockProverState {
    const stateTo = {
      ...state,
    };

    // Append tx to transaction list
    const transactionList = new DefaultProvableHashList(
      Field,
      state.transactionsHash
    );

    transactionList.push(transactionHash);
    stateTo.transactionsHash = transactionList.commitment;

    // Append tx to eternal transaction list
    // eslint-disable-next-line no-warning-comments
    // TODO Change that to the a sequence-state compatible transaction struct
    const eternalTransactionList = new DefaultProvableHashList(
      Field,
      state.eternalTransactionsHash
    );

    eternalTransactionList.push(transactionHash);
    stateTo.eternalTransactionsHash = eternalTransactionList.commitment;

    return stateTo;
  }

  @provableMethod()
  public proveTransaction(
    publicInput: BlockProverPublicInput,
    stateProof: StateTransitionProof,
    appProof: Proof<void, MethodPublicOutput>,
    executionData: BlockProverExecutionData
  ): BlockProverPublicOutput {
    const state: BlockProverState = {
      ...publicInput,
    };

    const bundleInclusionState = this.addTransactionToBundle(
      state,
      appProof.publicOutput.transactionHash
    );

    const stateTo = this.applyTransaction(
      bundleInclusionState,
      stateProof,
      appProof,
      executionData
    );

    return new BlockProverPublicOutput({
      ...stateTo,
      blockNumber: maxField(),
      closed: Bool(false),
    });
  }

  // public openBlock() {}
  //
  // public closeBlock() {}

  private assertSTProofInput(
    stateTransitionProof: StateTransitionProof,
    stateRoot: Field
  ) {
    stateTransitionProof.publicInput.stateTransitionsHash.assertEquals(
      Field(0),
      errors.stateProofNotStartingAtZero()
    );
    stateTransitionProof.publicInput.protocolTransitionsHash.assertEquals(
      Field(0),
      errors.stateProofNotStartingAtZero()
    );

    // Assert from state roots
    stateRoot.assertEquals(
      stateTransitionProof.publicInput.stateRoot,
      errors.propertyNotMatching("from state root")
    );
  }

  @provableMethod()
  public proveBlock(
    publicInput: BlockProverPublicInput,
    networkState: NetworkState,
    blockWitness: BlockHashMerkleTreeWitness,
    stateTransitionProof: StateTransitionProof,
    transactionProof: BlockProverProof
  ): {
    output: BlockProverPublicOutput;
    networkState: NetworkState;
  } {
    const state: BlockProverState = {
      ...publicInput,
    };

    // 1. Make assertions about the inputs
    publicInput.transactionsHash.assertEquals(Field(0));
    publicInput.networkStateHash.assertEquals(networkState.hash());

    transactionProof.publicInput.transactionsHash.assertEquals(Field(0));
    transactionProof.publicInput.blockHashRoot.assertEquals(Field(0));
    transactionProof.publicOutput.blockHashRoot.assertEquals(Field(0));
    transactionProof.publicInput.networkStateHash.assertEquals(
      transactionProof.publicOutput.networkStateHash
    );
    transactionProof.publicInput.eternalTransactionsHash.assertEquals(
      state.eternalTransactionsHash
    );

    // Verify ST Proof only if STs have been emitted,
    // otherwise we can input a dummy proof
    const stsEmitted = stateTransitionProof.publicOutput.stateTransitionsHash
      .equals(0)
      .and(stateTransitionProof.publicOutput.protocolTransitionsHash.equals(0))
      .not();
    stateTransitionProof.verifyIf(stsEmitted);

    this.assertSTProofInput(stateTransitionProof, state.stateRoot);

    // 2. Execute beforeBlock hooks
    const beforeBlockResult = this.executeBlockHooks(
      state,
      networkState,
      "beforeBlock"
    );

    const beforeBlockHashList = new DefaultProvableHashList(
      ProvableStateTransition
    );
    beforeBlockResult.stateTransitions.forEach((st) => {
      beforeBlockHashList.push(st.toProvable());
    });

    // We are reusing protocolSTs here as beforeBlock STs
    // TODO Not possible atm bcs we can't have a seperation between
    // protocol/runtime state roots, which we would for both before and after
    // to be able to emit STs

    // stateTransitionProof.publicInput.protocolTransitionsHash.assertEquals(
    //   beforeBlockHashList.commitment
    // );
    // state.stateRoot = stateTransitionProof.publicInput.protocolStateRoot;

    // For now
    beforeBlockHashList.commitment.assertEquals(Field(0));

    // 4. Apply TX-type BlockProof
    transactionProof.publicInput.networkStateHash.assertEquals(
      beforeBlockResult.networkState.hash()
    );
    transactionProof.publicInput.stateRoot.assertEquals(state.stateRoot);

    state.stateRoot = transactionProof.publicOutput.stateRoot;
    state.transactionsHash = transactionProof.publicOutput.transactionsHash;
    state.eternalTransactionsHash =
      transactionProof.publicOutput.eternalTransactionsHash;

    // 5. Execute afterBlock hooks
    const afterBlockResult = this.executeBlockHooks(
      state,
      beforeBlockResult.networkState,
      "afterBlock"
    );

    const afterBlockHashList = new DefaultProvableHashList(
      ProvableStateTransition
    );
    afterBlockResult.stateTransitions.forEach((st) => {
      afterBlockHashList.push(st.toProvable());
    });

    state.networkStateHash = afterBlockResult.networkState.hash();

    // We are reusing runtime STs here as afterBlock STs
    stateTransitionProof.publicInput.stateTransitionsHash.assertEquals(
      afterBlockHashList.commitment
    );
    state.stateRoot = stateTransitionProof.publicInput.stateRoot;

    // 6. Close block

    // Calculate the new block index
    const blockIndex = blockWitness.calculateIndex();

    blockWitness
      .calculateRoot(Field(0))
      .assertEquals(publicInput.blockHashRoot);

    state.blockHashRoot = blockWitness.calculateRoot(
      new BlockHashTreeEntry({
        transactionsHash: state.transactionsHash,
        closed: Bool(true),
      }).hash()
    );

    return {
      output: new BlockProverPublicOutput({
        ...state,
        blockNumber: blockIndex,
        closed: Bool(true),
      }),
      networkState: afterBlockResult.networkState,
    };
  }

  @provableMethod()
  public merge(
    publicInput: BlockProverPublicInput,
    proof1: BlockProverProof,
    proof2: BlockProverProof
  ): BlockProverPublicOutput {
    proof1.verify();
    proof2.verify();

    // Check state
    publicInput.stateRoot.assertEquals(
      proof1.publicInput.stateRoot,
      errors.stateRootNotMatching("publicInput.from -> proof1.from")
    );
    proof1.publicOutput.stateRoot.assertEquals(
      proof2.publicInput.stateRoot,
      errors.stateRootNotMatching("proof1.to -> proof2.from")
    );

    // Check transaction list
    publicInput.transactionsHash.assertEquals(
      proof1.publicInput.transactionsHash,
      errors.transactionsHashNotMatching("publicInput.from -> proof1.from")
    );
    proof1.publicOutput.transactionsHash.assertEquals(
      proof2.publicInput.transactionsHash,
      errors.transactionsHashNotMatching("proof1.to -> proof2.from")
    );

    // Check networkhash
    publicInput.networkStateHash.assertEquals(
      proof1.publicInput.networkStateHash,
      errors.transactionsHashNotMatching("publicInput.from -> proof1.from")
    );
    proof1.publicOutput.networkStateHash.assertEquals(
      proof2.publicInput.networkStateHash,
      errors.transactionsHashNotMatching("proof1.to -> proof2.from")
    );

    // Check blockHashRoot
    publicInput.blockHashRoot.assertEquals(
      proof1.publicInput.blockHashRoot,
      errors.transactionsHashNotMatching("publicInput.from -> proof1.from")
    );
    proof1.publicOutput.blockHashRoot.assertEquals(
      proof2.publicInput.blockHashRoot,
      errors.transactionsHashNotMatching("proof1.to -> proof2.from")
    );

    // Check eternalTransactionsHash
    publicInput.eternalTransactionsHash.assertEquals(
      proof1.publicInput.eternalTransactionsHash,
      errors.transactionsHashNotMatching("publicInput.from -> proof1.from")
    );
    proof1.publicOutput.eternalTransactionsHash.assertEquals(
      proof2.publicInput.eternalTransactionsHash,
      errors.transactionsHashNotMatching("proof1.to -> proof2.from")
    );

    // Assert closed indicator matches
    // (i.e. we can only merge TX-Type and Block-Type with each other)
    proof1.publicOutput.closed.assertEquals(
      proof2.publicOutput.closed,
      "Closed indicators not matching"
    );

    // Either
    // blockNumbers are unset and proofs are unclosed or
    // both blocks are closed, then they have to increment or
    // one block is closed, then height has to be the same

    // Imperative algo would look like
    // if(proof1.height == MAX && proof2.height == MAX){
    //   assert !proof1.closed && !proof2.closed;
    // }else if(proof1.closed && proof2.closed){
    //   assert proof1.height + 1 == proof2.height
    // // next one is omitted for now
    // }else if(proof1.closed || proof2.closed{
    //   assert proof1.height == proof2.height
    // }

    const proof1Height = proof1.publicOutput.blockNumber;
    const proof1Closed = proof1.publicOutput.closed;
    const proof2Height = proof2.publicOutput.blockNumber;
    const proof2Closed = proof2.publicOutput.closed;

    const isValidTransactionMerge = proof1Height
      .equals(maxField())
      .and(proof2Height.equals(proof1Height))
      .and(proof1Closed.or(proof2Closed).not());

    const isValidClosedMerge = proof1Closed
      .and(proof2Closed)
      .and(proof1Height.add(1).equals(proof2Height));

    isValidTransactionMerge
      .or(isValidClosedMerge)
      .assertTrue("Invalid BlockProof merge");

    return new BlockProverPublicOutput({
      stateRoot: proof2.publicOutput.stateRoot,
      transactionsHash: proof2.publicOutput.transactionsHash,
      networkStateHash: proof2.publicOutput.networkStateHash,
      blockHashRoot: proof2.publicOutput.blockHashRoot,
      eternalTransactionsHash: proof2.publicOutput.eternalTransactionsHash,
      // Provable.if(isValidClosedMerge, Bool(true), Bool(false));
      closed: isValidClosedMerge,
      blockNumber: proof2Height,
    });
  }

  /**
   * Creates the BlockProver ZkProgram.
   * Recursive linking of proofs is done via the previously
   * injected StateTransitionProver and the required AppChainProof class
   */
  public zkProgramFactory(): PlainZkProgram<
    BlockProverPublicInput,
    BlockProverPublicOutput
  > {
    const { prover, stateTransitionProver, runtime } = this;
    const StateTransitionProofClass = stateTransitionProver.zkProgram.Proof;
    const RuntimeProofClass = runtime.zkProgram.Proof;

    const proveTransaction = prover.proveTransaction.bind(prover);
    const merge = prover.merge.bind(prover);

    const program = Experimental.ZkProgram({
      publicInput: BlockProverPublicInput,
      publicOutput: BlockProverPublicOutput,

      methods: {
        proveTransaction: {
          privateInputs: [
            StateTransitionProofClass,
            RuntimeProofClass,
            BlockProverExecutionData,
          ],

          method(
            publicInput: BlockProverPublicInput,
            stateProof: StateTransitionProof,
            appProof: Proof<void, MethodPublicOutput>,
            executionData: BlockProverExecutionData
          ) {
            return proveTransaction(
              publicInput,
              stateProof,
              appProof,
              executionData
            );
          },
        },

        merge: {
          privateInputs: [
            SelfProof<BlockProverPublicInput, BlockProverPublicOutput>,
            SelfProof<BlockProverPublicInput, BlockProverPublicOutput>,
          ],

          method(
            publicInput: BlockProverPublicInput,
            proof1: BlockProverProof,
            proof2: BlockProverProof
          ) {
            return merge(publicInput, proof1, proof2);
          },
        },
      },
    });

    const methods = {
      proveTransaction: program.proveTransaction,
      merge: program.merge,
    };

    const SelfProofClass = Experimental.ZkProgram.Proof(program);

    return {
      compile: program.compile.bind(program),
      verify: program.verify.bind(program),
      Proof: SelfProofClass,
      methods,
    };
  }
}

/**
 * BlockProver class, which aggregates a AppChainProof and
 * a StateTransitionProof into a single BlockProof, that can
 * then be merged to be committed to the base-layer contract
 */
@injectable()
export class BlockProver extends ProtocolModule implements BlockProvable {
  public zkProgrammable: BlockProverProgrammable;

  public constructor(
    @inject("StateTransitionProver")
    public readonly stateTransitionProver: WithZkProgrammable<
      StateTransitionProverPublicInput,
      StateTransitionProverPublicOutput
    >,
    @inject("Runtime")
    public readonly runtime: WithZkProgrammable<undefined, MethodPublicOutput>,
    @injectAll("ProvableTransactionHook")
    transactionHooks: ProvableTransactionHook<unknown>[],
    @injectAll("ProvableBlockHook")
    blockHooks: ProvableBlockHook<unknown>[]
  ) {
    super();
    this.zkProgrammable = new BlockProverProgrammable(
      this,
      stateTransitionProver.zkProgrammable,
      runtime.zkProgrammable,
      transactionHooks,
      blockHooks
    );
  }

  public proveTransaction(
    publicInput: BlockProverPublicInput,
    stateProof: StateTransitionProof,
    appProof: Proof<void, MethodPublicOutput>,
    executionData: BlockProverExecutionData
  ): BlockProverPublicOutput {
    return this.zkProgrammable.proveTransaction(
      publicInput,
      stateProof,
      appProof,
      executionData
    );
  }

  public proveBlock(
    publicInput: BlockProverPublicInput,
    networkState: NetworkState,
    blockWitness: BlockHashMerkleTreeWitness,
    stateTransitionProof: StateTransitionProof,
    transactionProof: BlockProverProof
  ): BlockProverPublicOutput {
    return this.zkProgrammable.proveBlock(
      publicInput,
      networkState,
      blockWitness,
      stateTransitionProof,
      transactionProof
    ).output;
  }

  public merge(
    publicInput: BlockProverPublicInput,
    proof1: BlockProverProof,
    proof2: BlockProverProof
  ): BlockProverPublicOutput {
    return this.zkProgrammable.merge(publicInput, proof1, proof2);
  }
}
