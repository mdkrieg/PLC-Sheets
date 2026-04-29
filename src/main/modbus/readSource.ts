/**
 * Read source abstraction shared by single + redundant servers.
 *
 * Allows the PollEngine and WriteQueue to be agnostic of redundancy.
 */

import type { AddressKind } from '../../shared/types';

export interface ReadSource {
  /** Stable, log-friendly name */
  readonly name: string;
  read(kind: AddressKind, offset: number, length: number): Promise<number[] | boolean[]>;
  writeRegister(offset: number, value: number): Promise<void>;
  writeCoil(offset: number, state: boolean): Promise<void>;
}
