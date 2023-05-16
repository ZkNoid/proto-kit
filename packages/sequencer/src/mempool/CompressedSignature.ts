import { type Field, Scalar, Signature } from "snarkyjs";
import { notInCircuit } from "@yab/protocol";

// Not in circuit
export class CompressedSignature {
  @notInCircuit()
  public static fromSignature(sig: Signature) {
    const scalar = Scalar.toJSON(sig.s);
    return new CompressedSignature(sig.r, scalar);
  }

  public constructor(public readonly r: Field, public readonly s: string) {}

  @notInCircuit()
  public toSignature(): Signature {
    const scalar = Scalar.fromJSON(this.s);

    return Signature.fromObject({
      // eslint-disable-next-line id-length
      r: this.r,
      // eslint-disable-next-line id-length
      s: scalar,
    });
  }
}
