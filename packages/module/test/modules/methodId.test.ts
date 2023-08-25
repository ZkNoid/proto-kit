import "reflect-metadata";
import { Bool, Field } from "snarkyjs";
import { beforeAll, beforeEach } from "@jest/globals";

import { Runtime } from "../../src/runtime/Runtime";
import { MethodIdResolver } from "../../src/runtime/MethodIdResolver";
import {
  assert,
  InMemoryStateService,
  runtimeMethod,
  RuntimeModule,
  runtimeModule,
} from "../../src";
import { container } from "tsyringe";
import { Balances } from "./Balances";

interface AdminConfig {}

@runtimeModule()
class Admin extends RuntimeModule<AdminConfig> {
  @runtimeMethod()
  public isAdminWithAVeryVeryVeryVeryLongName() {
    assert(Field(1).equals(Field(1)));
  }
}

describe("methodId", () => {
  let runtime: Runtime<{ Admin: typeof Admin; Balance: typeof Balances }>;
  let resolver: MethodIdResolver;

  beforeAll(() => {
    container.clearInstances();

    runtime = Runtime.from({
      modules: {
        Admin,
        Balance: Balances,
      },

      config: {
        Admin: {},
        Balance: {
          test: Bool(true),
        },
      },

      state: new InMemoryStateService(),
    });
    runtime.start();

    resolver =
      runtime.dependencyContainer.resolve<MethodIdResolver>("MethodIdResolver");
  });

  it.each([
    ["Admin", "isAdminWithAVeryVeryVeryVeryLongName"],
    ["Balance", "getTotalSupply"],
    ["Balance", "getBalance"],
  ])(
    "should pass and encode correctly",
    (givenModuleName, givenMethodName) => {
      expect.assertions(2);

      const methodId = resolver.getMethodId(givenModuleName, givenMethodName);

      const [moduleName, methodName] = resolver.getMethodNameFromId(
        methodId
      ) ?? [undefined, undefined];

      expect(moduleName).toBe(givenModuleName);
      expect(methodName).toBe(givenMethodName);
    }
  );

  it("should fail for invalid module name", () => {
    expect.assertions(1);

    expect(() => {
      resolver.getMethodId("Admin2", "isAdminWithAVeryVeryVeryVeryLongName");
    }).toThrow(
      "Only known module names are allowed, using unknown module name: Admin2"
    );
  });
});
