import { EventEmitter } from 'node:events';
import type { JarvisEvent } from '../types.js';

class JarvisEventBus extends EventEmitter {
  emitEvent(type: JarvisEvent['type'], payload: unknown): void {
    const event: JarvisEvent = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emit('jarvis_event', event);
  }
}

export const eventBus = new JarvisEventBus();
eventBus.setMaxListeners(50);
