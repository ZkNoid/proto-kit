import { createClient, RedisClientType } from "redis";
import {
  SequencerModule,
  StorageDependencyMinimumDependencies,
} from "@proto-kit/sequencer";
import { DependencyFactory } from "@proto-kit/common";

import { RedisMerkleTreeStore } from "./services/redis/RedisMerkleTreeStore";

export interface RedisConnectionConfig {
  url: string;
  password: string;
}

export class RedisConnection
  extends SequencerModule<RedisConnectionConfig>
  implements DependencyFactory
{
  private redisClient?: RedisClientType;

  public get client(): RedisClientType {
    if (this.redisClient === undefined) {
      throw new Error(
        "Redis client not initialized yet, wait for .start() to be called"
      );
    }
    return this.redisClient;
  }

  public dependencies(): Pick<
    StorageDependencyMinimumDependencies,
    "asyncMerkleStore" | "unprovenMerkleStore"
  > {
    return {
      asyncMerkleStore: {
        useClass: RedisMerkleTreeStore,
      },
      unprovenMerkleStore: {
        useFactory: () => new RedisMerkleTreeStore(this, "unproven"),
      },
    };
  }

  public async init() {
    this.redisClient = createClient(this.config);
    await this.redisClient.connect();
  }

  public async start(): Promise<void> {
    await this.init();
  }
}
