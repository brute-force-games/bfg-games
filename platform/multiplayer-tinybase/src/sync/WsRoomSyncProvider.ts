import type { MergeableStore } from 'tinybase';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import type { WsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';

import type { RoomSyncHandle, RoomSyncProvider } from './RoomSyncProvider';

export class WsRoomSyncProvider implements RoomSyncProvider {
  async connect(input: { store: MergeableStore; wsUrl: string }): Promise<RoomSyncHandle> {
    const ws = new WebSocket(input.wsUrl);
    const synchronizer: WsSynchronizer<WebSocket> = await createWsSynchronizer(input.store, ws);
    return {
      start: () => synchronizer.startSync(),
      stop: () => synchronizer.stopSync(),
      destroy: () => synchronizer.destroy()
    };
  }
}

