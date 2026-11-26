// Shared timeline for the promo video. scene.html reads it as a global;
// render.mjs and audio.py parse the JSON object below, so keep it plain JSON.
window.TL = {
  "duration": 43,
  "fps": 30,
  "typing": [
    { "id": "cmd1", "start": 3.9, "cps": 18, "text": "node calc.mjs '2+3*4'" },
    { "id": "cmd2", "start": 6.3, "cps": 18, "text": "echo $?" },
    { "id": "cmd3", "start": 17.3, "cps": 30, "text": "endo attempt check -- node calc.mjs '2+3*4'" }
  ],
  "cues": {
    "hook1": 0.3, "hook2": 0.9, "hook3": 2.1,
    "term": 3.4, "out20": 5.5, "out0": 7.0, "cap1": 7.6, "cap2": 8.4,
    "bolt1": 9.4,
    "title": 10.0, "tag1": 11.2, "tag2": 12.4,
    "plan": 14.8, "receipt": 16.6, "receiptOk": 19.0, "ledger": 20.0, "fail": 21.6, "cap3": 22.6,
    "lanes": 25.0, "lane0": 25.6, "lane1": 26.05, "lane2": 26.5, "lane3": 26.95,
    "board": 28.4, "row0": 28.8, "row1": 29.2, "row2": 29.6, "row3": 30.0, "cap5": 31.4,
    "law0": 33.6, "law1": 34.8, "law2": 36.0, "law3": 37.2,
    "cta": 38.6, "url": 39.6, "end": 43.0
  },
  "bolts": [9.4, 21.6],
  "music": { "bpm": 100, "start": 10.0, "chords": ["Dm", "Bb", "F", "C"], "resolve": 38.6 }
};
