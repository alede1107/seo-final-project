# Accessibility Guide (inspired by Apple HIG)

Design so that people of all abilities can comfortably use your app or game. An accessible interface is:

- **Intuitive** – interactions are familiar and consistent.
- **Perceivable** – information is available through more than one sense.
- **Adaptable** – the UI works well with system accessibility settings and user preferences.

Audit your UI regularly and test with platform accessibility tools (for example, Accessibility Inspector on Apple platforms).

---

## 1. Vision

People may be blind, low‑vision, color‑blind, or in poor lighting. Make visual content flexible.

### Text and typography

- Support larger text sizes (aim to let people scale text significantly for comfort).
- Use readable default sizes per platform and avoid going below recommended minimums.
- If using thin or light fonts, increase size to preserve legibility.

### Color and contrast

- Check foreground/background contrast against WCAG or APCA guidance.
- Ensure body text and important icons meet minimum contrast ratios for typical text sizes.
- Verify contrast in both light and dark appearances.
- Prefer system-defined colors that automatically adapt to accessibility settings (e.g., increased contrast, dark mode).
- Don’t rely on color alone—use shapes, icons, patterns, or labels to distinguish states (errors vs success, different categories, etc.).

### Screen reader support

- Provide meaningful labels, traits, and order so screen readers (like VoiceOver) can describe your UI clearly.
- Make custom controls expose their role, state, and value to assistive technologies.

---

## 2. Hearing

People may be deaf, hard of hearing, or in noisy environments. Don’t rely solely on sound.

### Text alternatives for audio/video

Offer multiple text-based ways to experience media when audio contains important content:

- **Captions** – text synchronized with spoken audio for videos or cutscenes.
- **Subtitles** – on-screen dialogue in different languages.
- **Transcripts** – complete text for longer media like podcasts or talks.
- **Audio descriptions** – spoken narration describing visuals that aren’t otherwise conveyed.

Let people customize how this text appears (size, color, background where possible).

### Multimodal feedback

- Pair important sounds (success tones, errors, game events) with haptics when available.
- Add visual indicators for important off-screen or spatial events so people aren’t dependent on audio direction cues.

---

## 3. Mobility

Some people have limited dexterity, motor control, or use alternative input devices.

### Hit targets and spacing

- Use platform minimum control sizes or larger (e.g., tap targets that are comfortably large).
- Add enough padding between interactive elements to reduce accidental taps or clicks.

### Gestures and alternatives

- Use simple, common gestures for frequent actions; avoid complex multi-finger or multi-hand gestures for core flows.
- Provide alternatives to gestures (e.g., a button to dismiss a view rather than only swipe).
- Ensure key actions can be performed with assistive technologies (pointer control, switch devices, etc.).

### Assistive technologies

- Support features like VoiceOver, Full Keyboard Access, Pointer Control, Switch Control, and AssistiveTouch.
- Check that your controls are reachable and labeled appropriately when navigated via these technologies.

---

## 4. Speech

Some people have speech disabilities or prefer text-based interaction.

### Keyboard navigation

- Let people navigate and operate the app using only the keyboard.
- Respect system keyboard shortcuts; avoid overriding them.
- Test that Full Keyboard Access and similar features work correctly with your UI.

### Switch input

- Support Switch Control by ensuring that all interactive elements can be focused and activated programmatically.
- Avoid interactions that require long or complex sequences without alternative paths.

---

## 5. Cognitive

Reducing complexity benefits everyone, especially people with cognitive differences.

### Simplicity and consistency

- Keep actions predictable and easy to understand.
- Reuse platform-standard gestures and behaviors instead of inventing new ones where possible.

### Timing and pacing

- Avoid auto-dismiss views on short timers; allow explicit actions to close dialogs or notifications.
- Break multi-step flows into smaller screens or sections with one primary action per step.
- Consider difficulty or complexity options in games or demanding experiences (e.g., longer reaction times, assist modes).

### Media and motion

- Provide clear controls for audio/video playback; don’t auto-play without visible controls to pause/stop.
- Respect system settings that reduce flashing or rapid motion, and adjust your animations accordingly.
- Limit fast, blinking, or highly animated effects; favor gentler transitions and fades if reduced motion is enabled.

---

## 6. Platform and spatial experiences (visionOS-style environments)

Immersive environments can introduce motion sickness or physical strain.

- Keep content within a comfortable field of view; prefer horizontal layouts to minimize neck strain.
- Avoid rapid, intense motion in peripheral vision.
- Move cameras gently and avoid making the world feel like it’s moving uncontrollably around the user.
- Don’t lock content to the wearer’s head position in a way that feels confining or disables assistive features.
- Reduce the need for large, repetitive arm or hand gestures.

---

## 7. Process and resources

- Use platform tools (e.g., Accessibility Inspector) to find issues and see how assistive technologies interpret your UI.
- Run accessibility testing with diverse users, including people who rely on assistive features.
- Document which accessibility features you support so people can make informed choices (for example, via “accessibility nutrition” style labels).

---

## 8. COLOR

| Hex	| RGB | Notes
| #000000 |	(0,0,0) 
| #666666 |	(102,102,102)
| #979797 |	(151,151,151)
| #eeeeee |	(238,238,238)
| 	#5d6c59 |	(93,108,89) | Highlights


By following these guidelines, you’ll make your app more inclusive and more comfortable for everyone, while aligning with modern accessibility expectations on Apple platforms.