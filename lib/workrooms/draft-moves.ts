/**
 * Which reorder controls a draft block is offered.
 *
 * Decided by the block's **place in the rendered list**, never by its
 * `position`. A draft's positions are an ordering key with gaps in it — a
 * draft reading `0, 2, 5` is ordinary after a removal — so `position === 0`
 * says nothing about being first, and the last block's position is not
 * `count - 1`. The page passes the index it is rendering and the length of the
 * list it is rendering, and nothing else.
 *
 * A control that could not do anything is not offered at all rather than
 * disabled: the first block has nothing above it, the last nothing below, and
 * a lone block has neither. `moveItem` still answers an edge move with a quiet
 * no-op, for a crafted or stale request; this only decides what is drawn.
 */
export type DraftMoves = { up: boolean; down: boolean };

export function draftMoves(index: number, count: number): DraftMoves {
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) {
    return { up: false, down: false };
  }
  return { up: index > 0, down: index < count - 1 };
}
