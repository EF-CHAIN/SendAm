// Bezel finish presets for PhoneFrame. Each finish defines the brushed-metal
// frame gradient, the side-button gradient, the polished edge highlight, and
// the metallic aura halo so the three variants stay visually consistent with
// one another.
export const BEZEL_PRESETS = {
  midnight: {
    frame:
      'linear-gradient(135deg,#141417_0%,#2b2b31_18%,#3f3f48_38%,#4d4d58_50%,#3f3f48_62%,#2b2b31_82%,#141417_100%)',
    button: 'linear-gradient(90deg,#141417_0%,#3a3a42_60%,#1b1b1f_100%)',
    buttonAlt: 'linear-gradient(270deg,#141417_0%,#3a3a42_60%,#1b1b1f_100%)',
    edge: 'rgba(150,160,180,0.35)',
    halo: 'rgba(90,105,135,0.45)',
    bezel: '#050506',
  },
  titanium: {
    frame:
      'linear-gradient(135deg,#2e2e30_0%,#5d5d60_18%,#9c9c9f_38%,#cdcdd0_50%,#9c9c9f_62%,#5d5d60_82%,#2e2e30_100%)',
    button: 'linear-gradient(90deg,#2e2e30_0%,#7a7a7d_60%,#3a3a3c_100%)',
    buttonAlt: 'linear-gradient(270deg,#2e2e30_0%,#7a7a7d_60%,#3a3a3c_100%)',
    edge: 'rgba(255,255,255,0.35)',
    halo: 'rgba(190,195,200,0.45)',
    bezel: '#0a0a0a',
  },
  silver: {
    frame:
      'linear-gradient(135deg,#b7bbc2_0%,#e8eaee_18%,#fdfdfe_38%,#ffffff_50%,#fdfdfe_62%,#e8eaee_82%,#b7bbc2_100%)',
    button: 'linear-gradient(90deg,#b7bbc2_0%,#f2f4f7_60%,#9ea2a9_100%)',
    buttonAlt: 'linear-gradient(270deg,#b7bbc2_0%,#f2f4f7_60%,#9ea2a9_100%)',
    edge: 'rgba(255,255,255,0.85)',
    halo: 'rgba(232,236,240,0.6)',
    bezel: '#111214',
  },
};

export default BEZEL_PRESETS;
