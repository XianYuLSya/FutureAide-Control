import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Windows can briefly deny replacement of a state file that another reader has
// open. Retry only the atomic rename; the model or message write is never replayed.
export async function replaceStateFile(temporary, destination) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(temporary, destination); }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM' || attempt === 4) throw error;
      await delay(20 * (attempt + 1));
    }
  }
}
