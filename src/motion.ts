// Delta motion language: quick, springy, never in the way. Every animation in the app uses these,
// and the Settings "Animations" option (full / reduced / off) is applied through MotionConfig in App.
import type { Transition } from 'motion/react';

/** Snappy UI spring: menus, tabs, pills. Settles in ~250 ms without wobble. */
export const snap: Transition = { type: 'spring', stiffness: 560, damping: 42, mass: 0.7 };
/** Softer spring for bigger surfaces: panels, dialogs, the viewer. */
export const glide: Transition = { type: 'spring', stiffness: 340, damping: 34, mass: 0.9 };
/** Decelerating curve for fades and small moves. */
export const easeOut = [0.16, 1, 0.3, 1] as const;
export const fade: Transition = { duration: 0.18, ease: easeOut };
export const quick: Transition = { duration: 0.12, ease: easeOut };

/** Children appear one after another. */
export const stagger = (each = 0.025, delay = 0) => ({ animate: { transition: { staggerChildren: each, delayChildren: delay } } });
export const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: glide },
};
