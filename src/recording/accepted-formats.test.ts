import { describe, expect, it } from "vitest";

import {
  acceptedRecordingFormats,
  isAcceptedRecording,
} from "./accepted-formats";

describe("the recording drop zone", () => {
  it("announces mp3, m4a and wav to the file picker", () => {
    expect(acceptedRecordingFormats).toContain(".mp3");
    expect(acceptedRecordingFormats).toContain(".m4a");
    expect(acceptedRecordingFormats).toContain(".wav");
  });

  it("accepts an mp3, an m4a and a wav", () => {
    expect(
      isAcceptedRecording({ name: "seance.mp3", type: "audio/mpeg" }),
    ).toBe(true);
    expect(
      isAcceptedRecording({ name: "seance.m4a", type: "audio/x-m4a" }),
    ).toBe(true);
    expect(isAcceptedRecording({ name: "seance.wav", type: "audio/wav" })).toBe(
      true,
    );
  });

  it("accepts a file whose type the browser could not name", () => {
    expect(isAcceptedRecording({ name: "seance.m4a", type: "" })).toBe(true);
  });

  it("ignores the case of the extension", () => {
    expect(isAcceptedRecording({ name: "SEANCE.MP3", type: "" })).toBe(true);
  });

  it("refuses anything that is not one of the three formats", () => {
    expect(
      isAcceptedRecording({
        name: "terpnos-logos.pdf",
        type: "application/pdf",
      }),
    ).toBe(false);
    expect(isAcceptedRecording({ name: "seance.ogg", type: "audio/ogg" })).toBe(
      false,
    );
    expect(isAcceptedRecording({ name: "seance", type: "" })).toBe(false);
  });
});
