import { useState } from "react";

import { submitFeedback } from "../api";
import { useBackendStatus } from "../components/Layout";

const technologies = [
  {
    name: "AssemblyAI",
    role: "Finalized whole-video transcription used by the prepared-caption path.",
    href: "https://www.assemblyai.com/docs",
  },
  {
    name: "Gemini",
    role: "Optional English-to-ASL-gloss conversion. A deterministic fallback is used without a key.",
    href: "https://ai.google.dev/gemini-api/docs",
  },
  {
    name: "WLASL",
    role: "Word-level vocabulary source represented by the project word-to-URL map.",
    href: "https://github.com/dxli94/WLASL",
  },
  {
    name: "Chrome Extensions",
    role: "Tab-audio capture and the YouTube caption/sign overlay surface.",
    href: "https://developer.chrome.com/docs/extensions",
  },
  {
    name: "Flask + SQLite",
    role: "Shared preparation API, caption store, session history, and companion-site backend.",
    href: "https://flask.palletsprojects.com/",
  },
  {
    name: "Amazon S3",
    role: "Temporary source-audio storage and hosting for mapped vocabulary clips.",
    href: "https://docs.aws.amazon.com/s3/",
  },
];

const limitations = [
  "Vocabulary clips supplement written captions; they are not continuous ASL interpretation.",
  "The fixed vocabulary cannot represent every spoken word, name, idiom, or grammatical feature.",
  "ASL meaning also depends on facial expression, movement, space, context, and regional variation.",
  "Prepared batch rows currently do not expose speaker labels in this companion interface.",
  "Private, age-restricted, region-blocked, or bot-challenged YouTube videos may not download.",
  "This educational MVP has not completed formal usability testing with Deaf and hard-of-hearing users.",
];

export default function ReferencesPage() {
  const backendStatus = useBackendStatus();
  const [feedback, setFeedback] = useState("");
  const [feedbackState, setFeedbackState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [feedbackError, setFeedbackError] = useState("");

  const sendFeedback = async (event: React.FormEvent) => {
    event.preventDefault();
    setFeedbackState("sending");
    setFeedbackError("");
    try {
      await submitFeedback(feedback);
      setFeedback("");
      setFeedbackState("sent");
    } catch (submitError) {
      setFeedbackError(
        submitError instanceof Error ? submitError.message : "Feedback could not be saved.",
      );
      setFeedbackState("error");
    }
  };

  return (
    <div className="page-stack references-page">
      <section className="page-hero references-hero">
        <div>
          <span className="eyebrow">Transparency is part of accessibility</span>
          <h1>How CaptionAid works</h1>
          <p>
            CaptionAid is one product with two surfaces: a browser extension for the YouTube
            overlay and this companion website for preparation, review, and vocabulary discovery.
            Both use the same Flask pipeline and stored caption records.
          </p>
        </div>
        <div className={`architecture-status ${backendStatus}`}>
          <span aria-hidden="true" />
          <div>
            <strong>
              {backendStatus === "connected" ? "Shared backend online" : "Shared backend offline"}
            </strong>
            <small>Extension and website remain separate frontends.</small>
          </div>
        </div>
      </section>

      <nav className="section-index" aria-label="On this page">
        <a href="#architecture">Architecture</a>
        <a href="#technology">Technology</a>
        <a href="#accessibility">Accessibility</a>
        <a href="#limitations">Limitations</a>
        <a href="#feedback">Feedback</a>
      </nav>

      <section id="architecture" className="reference-section">
        <div className="section-number">01</div>
        <div>
          <span className="eyebrow">System architecture</span>
          <h2>One source of truth</h2>
          <p>
            A preparation request downloads public YouTube audio, stores it temporarily in S3,
            submits it to AssemblyAI, segments finalized words, creates ASL gloss, and maps
            supported tokens to clip URLs. SQLite stores the resulting rows by video and session.
          </p>
          <div className="architecture-flow" aria-label="CaptionAid processing stages">
            {[
              ["Input", "Extension or companion site"],
              ["Speech", "AssemblyAI finalized transcript"],
              ["Language", "English text to ASL gloss"],
              ["Vocabulary", "Gloss tokens to S3 clips"],
              ["Output", "Overlay, review, and library"],
            ].map(([label, detail], index) => (
              <article key={label}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{label}</strong>
                <small>{detail}</small>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="technology" className="reference-section">
        <div className="section-number">02</div>
        <div>
          <span className="eyebrow">Technology and sources</span>
          <h2>What participates in the result</h2>
          <div className="technology-grid">
            {technologies.map((technology) => (
              <article key={technology.name}>
                <h3>{technology.name}</h3>
                <p>{technology.role}</p>
                <a href={technology.href} target="_blank" rel="noreferrer">
                  Official reference
                  <span className="sr-only"> for {technology.name}</span>
                </a>
              </article>
            ))}
          </div>
          <div className="transparency-note">
            <strong>AI transparency</strong>
            <p>
              English captions come from AssemblyAI. Gloss may come from Gemini when configured;
              otherwise the backend uses deterministic token rules. Vocabulary matching itself is
              a fixed lookup, not generative video synthesis.
            </p>
          </div>
        </div>
      </section>

      <section id="accessibility" className="reference-section">
        <div className="section-number">03</div>
        <div>
          <span className="eyebrow">Accessibility principles</span>
          <h2>Captions stay primary</h2>
          <div className="principle-grid">
            {[
              ["Written context", "English captions remain visible even when no vocabulary clip matches."],
              ["No color-only meaning", "Statuses use text, shape, and color together."],
              ["Keyboard access", "Navigation, filters, queues, and playback actions use native controls."],
              ["Motion control", "Reduced-motion preferences disable nonessential transitions."],
              ["Honest output", "Gloss and word-level clips are labeled as supplementary vocabulary."],
              ["Responsive reading", "Transcript layouts stack cleanly on smaller screens."],
            ].map(([title, detail]) => (
              <article key={title}>
                <span aria-hidden="true">+</span>
                <h3>{title}</h3>
                <p>{detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="limitations" className="reference-section">
        <div className="section-number">04</div>
        <div>
          <span className="eyebrow">Known limitations</span>
          <h2>What this MVP does not promise</h2>
          <ul className="limitation-list">
            {limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      </section>

      <section id="feedback" className="reference-section">
        <div className="section-number">05</div>
        <div>
          <span className="eyebrow">Accessibility feedback</span>
          <h2>Tell the team where the barrier is</h2>
          <p>
            Feedback submitted here is stored in the project database so the team can review it
            during development.
          </p>
          {feedbackState === "sent" ? (
            <div className="alert success-alert" role="status">
              <strong>Feedback saved</strong>
              <p>Thank you for helping us improve CaptionAid.</p>
              <button type="button" onClick={() => setFeedbackState("idle")}>
                Submit another
              </button>
            </div>
          ) : (
            <form className="feedback-form" onSubmit={sendFeedback}>
              <label htmlFor="feedback-message">
                Describe the issue or suggestion
                <textarea
                  id="feedback-message"
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  rows={5}
                  maxLength={4000}
                  required
                  placeholder="For example, the clip controls are difficult to reach with a keyboard..."
                />
              </label>
              <div>
                <span>{feedback.length} / 4000</span>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={feedback.trim().length < 3 || feedbackState === "sending"}
                >
                  {feedbackState === "sending" ? "Saving..." : "Share feedback"}
                </button>
              </div>
              {feedbackState === "error" && (
                <p className="form-error" role="alert">{feedbackError}</p>
              )}
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
