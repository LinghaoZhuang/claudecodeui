/**
 * Centralized animation presets for framer-motion
 * All variants, springs, and transitions are defined here for consistency.
 */

// ─── Spring Configurations ───────────────────────────────────────────────────

export const springSnappy = { type: 'spring', stiffness: 500, damping: 30 };
export const springGentle = { type: 'spring', stiffness: 300, damping: 25 };
export const springBouncy = { type: 'spring', stiffness: 400, damping: 17 };

// ─── Ease / Tween Configurations ─────────────────────────────────────────────

export const easeFastOut = { type: 'tween', duration: 0.2, ease: [0.2, 0, 0, 1] };
export const easeSmooth = { type: 'tween', duration: 0.3, ease: [0.4, 0, 0.2, 1] };

// ─── Variant Presets ─────────────────────────────────────────────────────────

/** Simple fade in/out */
export const fadeVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: easeFastOut },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

/** Slide up + fade — messages, list items */
export const slideUpVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: easeSmooth },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15 } },
};

/** Scale + fade — modals, popovers */
export const scaleVariants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1, transition: springSnappy },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
};

/** Slide in from left — mobile sidebar drawer */
export const slideLeftVariants = {
  hidden: { x: '-100%' },
  visible: { x: 0, transition: springSnappy },
  exit: { x: '-100%', transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } },
};

/** Slide in from right — settings panel */
export const slideRightVariants = {
  hidden: { x: '100%' },
  visible: { x: 0, transition: springSnappy },
  exit: { x: '100%', transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } },
};

/** Slide down — dropdown menus, banners */
export const slideDownVariants = {
  hidden: { opacity: 0, y: -10 },
  visible: { opacity: 1, y: 0, transition: easeSmooth },
  exit: { opacity: 0, y: -10, transition: { duration: 0.15 } },
};

/** Backdrop / overlay */
export const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

/** Stagger container — wraps a list of children */
export const staggerContainerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
};

/** Stagger child item — each item in a staggered list */
export const staggerItemVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: easeSmooth },
};

/** Accordion expand/collapse — height + opacity */
export const accordionVariants = {
  hidden: { height: 0, opacity: 0, overflow: 'hidden' },
  visible: {
    height: 'auto',
    opacity: 1,
    overflow: 'hidden',
    transition: { height: easeSmooth, opacity: { duration: 0.2, delay: 0.05 } },
  },
  exit: {
    height: 0,
    opacity: 0,
    overflow: 'hidden',
    transition: { height: { duration: 0.2 }, opacity: { duration: 0.1 } },
  },
};
