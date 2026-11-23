/**
 * The step advance holds the ambient light still (P67, DS §1.1): the colours
 * the cook is reading must not move under the glide. The cook flow calls
 * `holdAmbientFor` with the advance's animations; `<body data-step-advancing>`
 * stands for as long as any are running, and `AmbientLight` freezes and
 * resumes on it.
 */
export const ADVANCING_ATTRIBUTE = "data-step-advancing";

let holds = 0;

export function holdAmbientFor(animations: Animation[]): void {
  if (animations.length === 0) return;
  holds += 1;
  document.body.setAttribute(ADVANCING_ATTRIBUTE, "");
  // A cancelled animation settles the promise too, so a hold is never leaked.
  void Promise.allSettled(animations.map((a) => a.finished)).then(() => {
    holds -= 1;
    if (holds === 0) document.body.removeAttribute(ADVANCING_ATTRIBUTE);
  });
}
