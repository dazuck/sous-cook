import { describe, expect, it } from "vitest";
import { photoProblem } from "./ask-photo";

// Review round 1 on "Ask Sous is a side panel": an empty file or one that is
// no picture was sent to Sous as a photo.
describe("photoProblem: what the camera's file input handed over", () => {
  const jpeg = "data:image/jpeg;base64,/9j/4AAQ";

  it("takes a picture, whatever kind", () => {
    expect(photoProblem({ size: 2048, type: "image/jpeg" }, jpeg)).toBeNull();
    expect(photoProblem({ size: 2048, type: "image/png" }, "data:image/png;base64,iVBOR")).toBeNull();
    // A file the browser gave no type, whose data says it is a picture.
    expect(photoProblem({ size: 2048, type: "" }, "data:image/heic;base64,AAAA")).toBeNull();
  });

  it("refuses an empty file as unread", () => {
    expect(photoProblem({ size: 0, type: "image/jpeg" }, "data:image/jpeg;base64,")).toBe("unread");
  });

  it("refuses what could not be read as a data address", () => {
    expect(photoProblem({ size: 10, type: "image/jpeg" }, null)).toBe("unread");
    expect(photoProblem({ size: 10, type: "image/jpeg" }, "about:blank")).toBe("unread");
  });

  it("refuses a file that is no picture, by its type or by its data", () => {
    expect(photoProblem({ size: 10, type: "application/pdf" }, "data:application/pdf;base64,JVBERi0=")).toBe("not-a-photo");
    expect(photoProblem({ size: 10, type: "text/plain" }, "data:text/plain;base64,aGk=")).toBe("not-a-photo");
    expect(photoProblem({ size: 10, type: "" }, "data:application/octet-stream;base64,AAAA")).toBe("not-a-photo");
    // A type that lies does not get past the data.
    expect(photoProblem({ size: 10, type: "image/png" }, "data:text/html;base64,PGI+")).toBe("not-a-photo");
  });
});
