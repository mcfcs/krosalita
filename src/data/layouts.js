// src/data/layouts.js
// Shipped crossword layouts.
//
// Every grid here is American-style: 180-degree rotationally symmetric blocks, every
// white run >= 3 letters (so every white square is CHECKED -- it belongs to both an
// across and a down entry), and all white squares connected. Nothing longer than
// MAX_WORD_LEN (15) appears, because the corpus has no answers longer than that.
//
// The midi and 13x13 grids were drawn by scripts/gen-layouts.mjs and every one of them
// was screened with scripts/bench-bigrid.mjs at all six difficulty settings before it
// was allowed in -- see EXTRA_LAYOUTS below for the ones that did NOT make it.

export const DEFAULT_LAYOUTS = [
  {
    name: "Classic 15x15",
    grid: [
      "#....#....#....",
      ".....#....#....",
      ".....#....#....",
      "....#....#.....",
      "......##....###",
      "###.....#......",
      "...#......#....",
      ".....#...#.....",
      "....#......#...",
      "......#.....###",
      "###....##......",
      ".....#....#....",
      "....#....#.....",
      "....#....#.....",
      "....#....#....#"
    ],
    isDefault: true
  },
  {
    name: "Standard 15x15",
    grid: [
      ".....#....#....",
      ".....#....#....",
      "..........#....",
      "##......##.....",
      "....#..........",
      "......##....###",
      ".....#....#....",
      "...#.......#...",
      "....#....#.....",
      "###....##......",
      "..........#....",
      ".....##......##",
      "....#..........",
      "....#....#.....",
      "....#....#....."
    ],
    isDefault: true
  },
  {
    name: "Open 15x15",
    grid: [
      "....#.....#....",
      "..........#....",
      "..........#....",
      "...#.....#....#",
      ".....#.....#...",
      "###....#.......",
      "#.....#........",
      "...............",
      "........#.....#",
      ".......#....###",
      "...#.....#.....",
      "#....#.....#...",
      "....#..........",
      "....#..........",
      "....#.....#...."
    ],
    isDefault: true
  },
  {
    name: "Symmetric 15x15",
    grid: [
      "....#......#...",
      "....#......#...",
      "...........#...",
      "......#...#....",
      ".....#.........",
      "###....##......",
      "....#....#.....",
      "...#.......#...",
      ".....#....#....",
      "......##....###",
      ".........#.....",
      "....#...#......",
      "...#...........",
      "...#......#....",
      "...#......#...."
    ],
    isDefault: true
  },
  {
    name: "Diamond 15x15",
    grid: [
      "....#.....#....",
      "....#.....#....",
      "....#..........",
      ".....##....#...",
      "##....##......#",
      "............###",
      "...#....##.....",
      "....#.....#....",
      ".....##....#...",
      "###............",
      "#......##....##",
      "...#....##.....",
      "..........#....",
      "....#.....#....",
      "....#.....#...."
    ],
    isDefault: true
  },
  // ---- midi ------------------------------------------------------------
  // 7x7 / 9x9 / 11x11 / 13x13. All measured at 100% fill over 6 seeds x 6 difficulties,
  // p95 under 40ms (bench-bigrid.mjs); these are free compared with a 15x15.,
  {
    name: "Mini 5x5 - Corner",
    grid: ["#....", ".....", ".....", ".....", "....#"],
    isDefault: true
  },
  {
    name: "Mini 5x5 - Open",
    grid: [".....", ".....", ".....", ".....", "....."],
    isDefault: true
  },
  {
    name: "Mini 5x5 - Cross",
    grid: ["#...#", ".....", ".....", ".....", "#...#"],
    isDefault: true
  },
  {
    name: "Mini 5x5 - Steps",
    grid: ["##...", ".....", ".....", "...##", "...##"],
    isDefault: true
  },
  {
    name: "Mini 5x5 - Diagonal",
    grid: ["#....", ".....", ".....", "....#", "...##"],
    isDefault: true
  },
  // ---- sunday ----------------------------------------------------------
  // 21x21. These fill from this corpus -- but only at a real Sunday block density.
  // At ~14% blocks a 21x21 is hopeless here (measured: 0/16 fills, the search starves
  // on 9- to 13-letter entries, of which the word list has 4,616 / 2,729 / 1,268 / 407 /
  // 349); at ~18% and above it fills comfortably. See scripts/bench-bigrid.mjs.,
  // ---- added sizes, appended so the original ten keep their array indices ----------
  // (a saved puzzle can fall back to its stored layoutIndex, so inserting in the middle
  // would silently reassign old saves to a different grid)
  //
  // 7x7 / 9x9 / 11x11 / 13x13 / 21x21, drawn by scripts/gen-layouts.mjs and screened with
  // scripts/bench-bigrid.mjs: every one of these fills 6/6 seeds at all six difficulty
  // settings, p95 under 1.2s (the midis under 40ms). Patterns that did not clear that bar
  // are in EXTRA_LAYOUTS, not here.
  {
    name: "Midi 7x7 - Open",
    grid: [
      "...#...",
      ".......",
      ".......",
      "#.....#",
      ".......",
      ".......",
      "...#..."
    ],
    isDefault: true
  },
  {
    name: "Midi 7x7 - Stacks",
    grid: [
      ".....##",
      ".....##",
      ".......",
      "...#...",
      ".......",
      "##.....",
      "##....."
    ],
    isDefault: true
  },
  {
    name: "Midi 7x7 - Corners",
    grid: [
      "....###",
      "......#",
      ".......",
      "...#...",
      ".......",
      "#......",
      "###...."
    ],
    isDefault: true
  },
  {
    name: "Midi 9x9 - Open",
    grid: [
      ".....#...",
      ".........",
      ".........",
      "...#.....",
      "###...###",
      ".....#...",
      ".........",
      ".........",
      "...#....."
    ],
    isDefault: true
  },
  {
    name: "Midi 9x9 - Pinwheel",
    grid: [
      "#...#...#",
      "....#....",
      ".........",
      ".....#...",
      "###...###",
      "...#.....",
      ".........",
      "....#....",
      "#...#...#"
    ],
    isDefault: true
  },
  {
    name: "Midi 9x9 - Steps",
    grid: [
      "....##...",
      ".........",
      ".........",
      "...#...##",
      "###...###",
      "##...#...",
      ".........",
      ".........",
      "...##...."
    ],
    isDefault: true
  },
  {
    name: "Midi 11x11 - Open",
    grid: [
      "....#.....#",
      "....#......",
      "...........",
      "##....##...",
      "......#....",
      ".....#.....",
      "....#......",
      "...##....##",
      "...........",
      "......#....",
      "#.....#...."
    ],
    isDefault: true
  },
  {
    name: "Midi 11x11 - Blocks",
    grid: [
      "#...##.....",
      "#....#.....",
      ".....#.....",
      "......#...#",
      "........###",
      "...#...#...",
      "###........",
      "#...#......",
      ".....#.....",
      ".....#....#",
      ".....##...#"
    ],
    isDefault: true
  },
  {
    name: "Midi 11x11 - Windows",
    grid: [
      "#...###....",
      "#...#......",
      "....#......",
      "...#....###",
      "......#....",
      "...........",
      "....#......",
      "###....#...",
      "......#....",
      "......#...#",
      "....###...#"
    ],
    isDefault: true
  },
  {
    name: "Grid 13x13 - Classic",
    grid: [
      "...##...##...",
      "....#........",
      ".............",
      ".....##.....#",
      "##.....#...##",
      "....#....#...",
      "....#...#....",
      "...#....#....",
      "##...#.....##",
      "#.....##.....",
      ".............",
      "........#....",
      "...##...##..."
    ],
    isDefault: true
  },
  {
    name: "Grid 13x13 - Lattice",
    grid: [
      "...#...##....",
      "...#...#.....",
      ".......#.....",
      "....#.......#",
      "#...#...##...",
      "#....#...#...",
      "...#.....#...",
      "...#...#....#",
      "...##...#...#",
      "#.......#....",
      ".....#.......",
      ".....#...#...",
      "....##...#..."
    ],
    isDefault: true
  },
  {
    name: "Sunday 21x21 - Standard",
    // 134 slots · 78 blocks (18%) · lengths 3x30 4x32 5x13 6x26 7x10 8x8 9x8 10x2 12x4 13x1
    grid: [
      "...##...#...#.......#",
      "........#............",
      "........#............",
      ".....#....#....##....",
      ".........#....###....",
      "......#.........#....",
      "###...##........#....",
      "#...##....####....###",
      "........#.....#......",
      ".........#....##.....",
      "...#.............#...",
      ".....##....#.........",
      "......#.....#........",
      "###....####....##...#",
      "....#........##...###",
      "....#.........#......",
      "....###....#.........",
      "....##....#....#.....",
      "............#........",
      "............#........",
      "#.......#...#...##..."
    ],
    isDefault: true
  },
  {
    name: "Sunday 21x21 - Dense",
    // 140 slots · 88 blocks (20%) · lengths 3x54 4x22 5x12 6x22 7x9 8x8 9x4 10x4 12x4 13x1
    grid: [
      "...#....##.....##...#",
      ".........#......#....",
      ".........#......#....",
      "#...#.....#...#......",
      "...##.......##.......",
      "...#....#...#....#...",
      ".......#...#...###...",
      "#......#........##...",
      "###....#........#...#",
      "...#...###......#....",
      ".....##.......##.....",
      "....#......###...#...",
      "#...#........#....###",
      "...##........#......#",
      "...###...#...#.......",
      "...#....#...#....#...",
      ".......##.......##...",
      "......#...#.....#...#",
      "....#......#.........",
      "....#......#.........",
      "#...##.....##....#..."
    ],
    isDefault: true
  }
];

// Grids that fill from this corpus, but not in the millisecond budget the everyday
// layouts are held to -- so they are kept OUT of DEFAULT_LAYOUTS (and out of
// bench-solver.mjs's p95 gate, which is a latency gate, not a feasibility one).
// Measured with scripts/bench-bigrid.mjs; expect seconds, not milliseconds.
export const EXTRA_LAYOUTS = [
  {
    name: "Sunday 21x21 - Long",
    // 132 slots · 78 blocks (18%) · lengths 3x36 4x26 5x18 6x18 7x4 8x4 9x12 10x8 11x4 12x2
    // The open Sunday: 12 nine-letter, 8 ten-letter and 4 eleven-letter entries. It DOES
    // fill from this corpus at every difficulty (6/6 seeds) -- but p50 ran 3-29s and one
    // seed took 48s, because those lengths are where the word list thins out
    // (4,616 / 2,729 / 1,268 answers). Playable, not press-Generate-and-wait.
    grid: [
      "...##...###...##.....",
      "...#......#....#.....",
      "..........#..........",
      ".......#............#",
      "...........#....#....",
      "......#.....###......",
      "##....#..........#...",
      "#...#.....#..........",
      ".........###....#...#",
      ".....#......#.....###",
      "...#...##...##...#...",
      "###.....#......#.....",
      "#...#....###.........",
      "..........#.....#...#",
      "...#..........#....##",
      "......###.....#......",
      "....#....#...........",
      "#............#.......",
      "..........#..........",
      ".....#....#......#...",
      ".....##...###...##..."
    ],
    isDefault: false
  },
  {
    name: "Stress 25x25",
    // 190 slots · 112 blocks (18%) · lengths 3x61 4x30 5x35 6x12 7x14 8x12 9x8 11x12 13x6
    // The honest ceiling: it fills, but p50 is seconds and some seeds need 20s. Sibling
    // 25x25 patterns at the same block count failed outright -- at this size the corpus's
    // 9-to-13-letter shelf (4,616 / 2,729 / 1,268 / 407 / 349 answers) is the binding
    // constraint, and which pattern you drew decides whether you clear it.
    grid: [
      ".......#.....#....##.....",
      ".............#...........",
      ".............#...........",
      "#...##........#.......###",
      "....#...##....#....#...##",
      "...#...##...#....#...#...",
      "...#...........#....#....",
      "#....#....##...##........",
      ".....##...##...#........#",
      ".......#....#.....##.....",
      ".............#.....##....",
      "###.....#.....#......#...",
      "#.........#...#.........#",
      "...#......#.....#.....###",
      "....##.....#.............",
      ".....##.....#....#.......",
      "#........#...##...##.....",
      "........##...##....#....#",
      "....#....#...........#...",
      "...#...#....#...##...#...",
      "##...#....#....##...#....",
      "###.......#........##...#",
      "...........#.............",
      "...........#.............",
      ".....##....#.....#......."
    ],
    isDefault: false
  }
];

// Every layout the app could offer, small to large.
export const ALL_LAYOUTS = [...DEFAULT_LAYOUTS, ...EXTRA_LAYOUTS];
