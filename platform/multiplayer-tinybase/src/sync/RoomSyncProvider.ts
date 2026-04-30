import type { MergeableStore } from 'tinybase';

export type RoomSyncHandle = {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  destroy(): void;
};

export interface RoomSyncProvider {
  connect(input: { store: MergeableStore; wsUrl: string }): Promise<RoomSyncHandle>;
}

