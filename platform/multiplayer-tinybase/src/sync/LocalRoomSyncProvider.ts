import type { RoomSyncHandle, RoomSyncProvider } from './RoomSyncProvider';

const noop = () => Promise.resolve();

const localHandle: RoomSyncHandle = { start: noop, stop: noop, destroy: () => {} };

export class LocalRoomSyncProvider implements RoomSyncProvider {
  async connect(): Promise<RoomSyncHandle> {
    return localHandle;
  }
}
