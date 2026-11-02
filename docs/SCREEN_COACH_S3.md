# S3 — Annotate on Screen + Save to Notebook (Windows)

Replaces the previous S3 in [SCREEN_COACH.md](SCREEN_COACH.md). Read that brief and its
**Decisions** section first; everything there still applies (Rust owns capture and upload,
screenshots never enter page JS except an explicitly confirmed clip, blocked apps, redaction,
rule-based safety check, capture scope rules). Decision 9 there records how the open questions
below were settled; where it differs from this brief, the decision wins.

---

## 1. What the user experiences

### A. PDF question

1. The student has a PDF open (Edge, Acrobat, Chrome, any viewer) on "Question 3".
2. Holds **Ctrl + Alt + Space**: "Help me with question 3."
3. The tutor captures the screen, finds question 3, and **draws beside it** in violet ink:
   - circles or underlines the key words in the question
   - writes a short hint or the first step in the **free space next to the question** (margin),
     never on top of the text
   - says one or two short sentences out loudCompany
     Company name*
     neb
     Describe what your company does in 50 characters or less.*
     Screen tutor that saves every lesson to replay
     Company URL, if any
     https://www.myneb.si/
     If you have a demo, attach it below.
     Anything that shows us how the product works. Please limit to 3 minutes / 100 MB.

Drop here or browse
Please provide a link to the product, if any.
https://www.myneb.si
If login credentials are required for the link above, enter them here.

username / password
What is your company going to make? Please describe your product and what it does or will do.
We're building neb, which explains anything on your screen in your own language and saves every explanation to your notebook so you can find it again.
Imagine you're from Dhaka, studying in Toronto. It's midnight, and you're watching a 40-minute statistics lecture in English. Every few minutes you pause, open a translator and try to piece the sentence back together. But when you translate a concept to understand it, you lose the English words your exam will use. A week later, with the exam close, you can't find any of it again.
With neb, you hold two keys, circle the formula on your screen and ask in Bengali, "what does this mean?" neb answers out loud in Bengali and sketches over the lecture to show you. The words it writes stay in English, the same ones your professor uses and your exam will ask about. It works the same way on a journal article, an error in your code or a video-editing tutorial.
That answer doesn't disappear. neb saves it in your statistics notebook, right where it belongs, linked to the exact second of the lecture where you got stuck. The night before the exam you type "standard deviation", and there it is: thirty seconds instead of forty minutes. A few days later, neb asks you one quick question about it, so you know it actually stuck.
neb works in Bengali, Mandarin and French today. It's for anyone who learns in English but thinks in another language, and we're experimenting with international student users for now but later we will increase our scope further.
Where do you live now, and where would the company be based after YC?
Use the format City A, Country A / City B, Country B

Toronto, Canada and Dhaka, Bangladesh / San Francisco, USA
Explain your decision regarding location.
All three of us in the founding team are ready to move to San Francisco immediately upon acceptance. We are prepared to establish our permanent global headquarters in the Bay Area to build our AI model alongside the world’s best tech ecosystem to ship features for global market and getting access to investor funds and expert mentorships
Our tech team lives in Toronto, Canada, and operational founder lives in Dhaka, Bangladesh as of now. We use this time gap as a 24-hour execution loop.
During my day, our operational founder handles operations, talks to users, and gathers feedback from our low-cost ad markets in South Asia. Before Toronto wakes up, she logs these insights and bugs as clear, prioritized tasks. The tech founders build and ship the updates during their day while she sleeps,and she tests them live with users the next morning.
This setup lets us sell premium subscriptions in the West, run ad-supported models in Asia, and keep our operational costs dirt cheap,all while moving twice as fast as a local team.
Progress
How far along are you?
Working beta, not launched yet. 17 students used it, and all 17 came back on a second day. They circled things on their screen, heard explanations in Bengali and French, and replayed the saved moments in their notebooks. Together they saved 5 moments and replayed 2.
Everything in our product description works today: circle and ask by voice, the explanation with drawing, saving to the right notebook chapter, search, replay, the follow-up questions days later and handwriting checking. The main complaint is speed. One tester said it "sometimes lags a bit"; an answer takes about 7 seconds today, and we're working to get it under 4 seconds.
200 people joined the waitlist from teaser videos that reached 30,000 views on Instagram and Facebook oganically within 5 days.
We're three students paying for every model call ourselves, which is why the beta stayed at 15 people. Each question costs us about $6. We'll launch on 11/8/2026 as a free app capped at 15 questions per person per day, letting the waitlistes people tryout so the bill stays within what we can pay, and use their feedback to decide what to charge for.
How long have each of you been working on this? How much of that has been full-time? Please explain.
We have been building this new AI EdTech product for exactly 10 days, since a wild spark on October 23, 2026. Every single hour since has been a non-stop, full-time sprint. We sleep in shifts just to keep our execution loop running nearly 24/7.
The real fire was lit back in March 2026. For seven intense months, the three of us worked full-time building Clarus, a healthcare SaaS. We proved our execution early,winning Best Healthcare Solution at Hack Canada and the Google AI Hackathon, and securing spots in York University’s YSpace cohort and North South University’s Startup Next cohort. We had the backing and the talent, but healthcare compliance felt like running through wet cement. Looking back, our only regret is that we didn't expand our horizons a month sooner. We were so hungry to move fast, but the industry was forcing us to slow down.
Then, inspiration struck like lightning. At 5:00 AM Dhaka time,one of our tech founders had a breakthrough idea, called our operational founder in Bangladesh "yo are you awake I GOT AN IDEA what if there is someone helping you while you are writing on your ipasd notes or oneNote", and this woke her out of bed. Instead of a let’s talk later this morning, she listened to idea, criticised and validated it. We started building that exact minute. The tech team slammed their keys to ship code, and the operational founder ran out into her local community to gather raw, instant feedback.
When we took this new direction to our mentors at YSpace 2 days ago on 10/28/2026, they immediately looked at the rapid market pull and validated the transition, backing us fully on this new trajectory. Because we already had seven months of bulletproof team chemistry and top-tier incubator validation, we hit the ground running at a terrifying speed.
We turned our 11-hour time gap into a superpower. Our startup uniquely never sleeps: when Toronto closes their laptops to rest, Bangladesh takes the baton to run live user tests and lock in growth; when Bangladesh sleeps, Toronto wakes up to a fresh, prioritized list of user demands and codes all day. Driven by pure adrenaline, these 10 days have been electric. We built the product from scratch, dropped a teaser that exploded with 11.3k views in just 24 hours, brought on 15 obsessed beta testers, and stacked a waitlist of 200 eager students. We aren't just a remote team; we are a 24-hour global engine that refuses to stop.
What tech stack are you using, or planning to use, to build this product? Include AI models and AI coding tools you use.
Windows screen coach: Tauri (Rust). Backend: FastAPI and Supabase (Postgres with row-level security, storage). Models: Gemini for handwriting reading and tutoring, ElevenLabs for voice. Every step neb shows is verified in code before display: SymPy for algebra, calculus and units, a balance checker for chemistry equations, Pyodide for code. Spaced review uses the FSRS algorithm. PDFs are rendered with pdfium. Website: Next.js on Vercel, Resend for email. AI coding tool: Claude Code
Are people using your product?
Yes
No
When will you have a version people can use?
It already works: 15 students used the beta in 10/27/2026, and all 15 came back on a second day. We paused it because we pay for model calls ourselves. We’ll open it to our 200-person waitlist on 11/08/2026, in groups of 50, with a cap of 15 questions per person per day.
Do you have revenue?
Yes
No
If you are applying with the same idea as a previous batch, did anything change? If you applied with a different idea, why did you pivot and what did you learn from the last idea?
This is our first application
If you have already participated or committed to participate in an incubator, "accelerator" or "pre-accelerator" program, please tell us about it.
We are still in a cohort at Yspace, York University since we pivoted our previous healthcare startup idea to neb 8 days ago on 10/23/2026.
Idea
Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you’re making?
Imagine trying to learn rocket science while constantly translating the instructions in your head. That’s the daily reality for millions of international students. We learn from English materials, but we think in our native languages. I’m building Neb because your tools shouldn't force you to choose between understanding a concept deeply and passing an English exam.
Being a student right now gives me a front-row seat to this frustration. I am deeply embedded in these student communities, mapping out exactly where people get stuck, crack, or give up.
Our domain expertise is that we are the user. One of us is also an animator, which is why neb explains by drawing on your screen, not only by talking.
How do we know they need it? Because nobody wants to rewatch a 40-minute video tutorial just to find a 30-second answer. When we told 20 students they could search their notebook for a single word like "color wheels" and jump straight to the exact second they were confused, they immediately tried to download it. We are solving a pain point that makes people want to slam their laptops shut.
Who are your competitors? What do you understand about your business that they don’t?
SCompany
Company name*
neb
Describe what your company does in 50 characters or less.*
Screen tutor that saves every lesson to replay
Company URL, if any
https://www.myneb.si/
If you have a demo, attach it below.
Anything that shows us how the product works. Please limit to 3 minutes / 100 MB.

Drop here or browse
Please provide a link to the product, if any.
https://www.myneb.si
If login credentials are required for the link above, enter them here.

username / password
What is your company going to make? Please describe your product and what it does or will do.
We're building neb, which explains anything on your screen in your own language and saves every explanation to your notebook so you can find it again.
Imagine you're from Dhaka, studying in Toronto. It's midnight, and you're watching a 40-minute statistics lecture in English. Every few minutes you pause, open a translator and try to piece the sentence back together. But when you translate a concept to understand it, you lose the English words your exam will use. A week later, with the exam close, you can't find any of it again.
With neb, you hold two keys, circle the formula on your screen and ask in Bengali, "what does this mean?" neb answers out loud in Bengali and sketches over the lecture to show you. The words it writes stay in English, the same ones your professor uses and your exam will ask about. It works the same way on a journal article, an error in your code or a video-editing tutorial.
That answer doesn't disappear. neb saves it in your statistics notebook, right where it belongs, linked to the exact second of the lecture where you got stuck. The night before the exam you type "standard deviation", and there it is: thirty seconds instead of forty minutes. A few days later, neb asks you one quick question about it, so you know it actually stuck.
neb works in Bengali, Mandarin and French today. It's for anyone who learns in English but thinks in another language, and we're experimenting with international student users for now but later we will increase our scope further.
Where do you live now, and where would the company be based after YC?
Use the format City A, Country A / City B, Country B

Toronto, Canada and Dhaka, Bangladesh / San Francisco, USA
Explain your decision regarding location.
All three of us in the founding team are ready to move to San Francisco immediately upon acceptance. We are prepared to establish our permanent global headquarters in the Bay Area to build our AI model alongside the world’s best tech ecosystem to ship features for global market and getting access to investor funds and expert mentorships
Our tech team lives in Toronto, Canada, and operational founder lives in Dhaka, Bangladesh as of now. We use this time gap as a 24-hour execution loop.
During my day, our operational founder handles operations, talks to users, and gathers feedback from our low-cost ad markets in South Asia. Before Toronto wakes up, she logs these insights and bugs as clear, prioritized tasks. The tech founders build and ship the updates during their day while she sleeps,and she tests them live with users the next morning.
This setup lets us sell premium subscriptions in the West, run ad-supported models in Asia, and keep our operational costs dirt cheap,all while moving twice as fast as a local team.
Progress
How far along are you?
Working beta, not launched yet. 17 students used it, and all 17 came back on a second day. They circled things on their screen, heard explanations in Bengali and French, and replayed the saved moments in their notebooks. Together they saved 5 moments and replayed 2.
Everything in our product description works today: circle and ask by voice, the explanation with drawing, saving to the right notebook chapter, search, replay, the follow-up questions days later and handwriting checking. The main complaint is speed. One tester said it "sometimes lags a bit"; an answer takes about 7 seconds today, and we're working to get it under 4 seconds.
200 people joined the waitlist from teaser videos that reached 30,000 views on Instagram and Facebook oganically within 5 days.
We're three students paying for every model call ourselves, which is why the beta stayed at 15 people. Each question costs us about $6. We'll launch on 11/8/2026 as a free app capped at 15 questions per person per day, letting the waitlistes people tryout so the bill stays within what we can pay, and use their feedback to decide what to charge for.
How long have each of you been working on this? How much of that has been full-time? Please explain.
We have been building this new AI EdTech product for exactly 10 days, since a wild spark on October 23, 2026. Every single hour since has been a non-stop, full-time sprint. We sleep in shifts just to keep our execution loop running nearly 24/7.
The real fire was lit back in March 2026. For seven intense months, the three of us worked full-time building Clarus, a healthcare SaaS. We proved our execution early,winning Best Healthcare Solution at Hack Canada and the Google AI Hackathon, and securing spots in York University’s YSpace cohort and North South University’s Startup Next cohort. We had the backing and the talent, but healthcare compliance felt like running through wet cement. Looking back, our only regret is that we didn't expand our horizons a month sooner. We were so hungry to move fast, but the industry was forcing us to slow down.
Then, inspiration struck like lightning. At 5:00 AM Dhaka time,one of our tech founders had a breakthrough idea, called our operational founder in Bangladesh "yo are you awake I GOT AN IDEA what if there is someone helping you while you are writing on your ipasd notes or oneNote", and this woke her out of bed. Instead of a let’s talk later this morning, she listened to idea, criticised and validated it. We started building that exact minute. The tech team slammed their keys to ship code, and the operational founder ran out into her local community to gather raw, instant feedback.
When we took this new direction to our mentors at YSpace 2 days ago on 10/28/2026, they immediately looked at the rapid market pull and validated the transition, backing us fully on this new trajectory. Because we already had seven months of bulletproof team chemistry and top-tier incubator validation, we hit the ground running at a terrifying speed.
We turned our 11-hour time gap into a superpower. Our startup uniquely never sleeps: when Toronto closes their laptops to rest, Bangladesh takes the baton to run live user tests and lock in growth; when Bangladesh sleeps, Toronto wakes up to a fresh, prioritized list of user demands and codes all day. Driven by pure adrenaline, these 10 days have been electric. We built the product from scratch, dropped a teaser that exploded with 11.3k views in just 24 hours, brought on 15 obsessed beta testers, and stacked a waitlist of 200 eager students. We aren't just a remote team; we are a 24-hour global engine that refuses to stop.
What tech stack are you using, or planning to use, to build this product? Include AI models and AI coding tools you use.
Windows screen coach: Tauri (Rust). Backend: FastAPI and Supabase (Postgres with row-level security, storage). Models: Gemini for handwriting reading and tutoring, ElevenLabs for voice. Every step neb shows is verified in code before display: SymPy for algebra, calculus and units, a balance checker for chemistry equations, Pyodide for code. Spaced review uses the FSRS algorithm. PDFs are rendered with pdfium. Website: Next.js on Vercel, Resend for email. AI coding tool: Claude Code
Are people using your product?
Yes
No
When will you have a version people can use?
It already works: 15 students used the beta in 10/27/2026, and all 15 came back on a second day. We paused it because we pay for model calls ourselves. We’ll open it to our 200-person waitlist on 11/08/2026, in groups of 50, with a cap of 15 questions per person per day.
Do you have revenue?
Yes
No
If you are applying with the same idea as a previous batch, did anything change? If you applied with a different idea, why did you pivot and what did you learn from the last idea?
This is our first application
If you have already participated or committed to participate in an incubator, "accelerator" or "pre-accelerator" program, please tell us about it.
We are still in a cohort at Yspace, York University since we pivoted our previous healthcare startup idea to neb 8 days ago on 10/23/2026.
Idea
Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you’re making?
Imagine trying to learn rocket science while constantly translating the instructions in your head. That’s the daily reality for millions of international students. We learn from English materials, but we think in our native languages. I’m building Neb because your tools shouldn't force you to choose between understanding a concept deeply and passing an English exam.
Being a student right now gives me a front-row seat to this frustration. I am deeply embedded in these student communities, mapping out exactly where people get stuck, crack, or give up.
Our domain expertise is that we are the user. One of us is also an animator, which is why neb explains by drawing on your screen, not only by talking.
How do we know they need it? Because nobody wants to rewatch a 40-minute video tutorial just to find a 30-second answer. When we told 20 students they could search their notebook for a single word like "color wheels" and jump straight to the exact second they were confused, they immediately tried to download it. We are solving a pain point that makes people want to slam their laptops shut.
Who are your competitors? What do you understand about your business that they don’t?

What we understand: a student learning in a second language has three problems at once. They need to understand the idea in their own language, keep the English words their exam uses, and find the explanation again a week later. Each competitor solves one. A translator helps you understand but drops the English terms. A screen assistant explains, and then the answer is gone. A notes app keeps things, but only what you write down yourself. neb does all three in one action: it explains in your language, keeps the labels in English and saves the moment to your notebook automatically.
A small study bar at the top of your screen shows your session, your saved moments and your music, so you never have to leave what you’re learning.

How do or will you make money? How much could you make?
(We realize you can’t know precisely, but give your best estimate)

We make money from subscriptions, plus ads in lower-income markets.
In the US, Canada and Europe, neb is free for 15 questions a day, or $15.99 a month for neb Plus with a fair-use limit of 50 questions a day. For these Western markets, Stripe is already integrated to handle credit/debit card processing smoothly. We are also slowly moving towards integrating Upay to further expand local mobile financial service options alongside our primary channels.
In Bangladesh, India and similar markets, students get a smaller free cap. When they hit it, they can watch a short ad to unlock one more question, or pay a local price of about $2 a month. Because commercial banking isn't common for international credit or debit cards as many users refuse to pay bank charges they use bKash and Nagad, which allow them to pay easily using just their SIM card number. Since third-party payment aggregators like SSLCOMMERZ are too expensive at early stages, we handle this using a token reference system integrated directly into our forms and system architecture (similar to how streak platforms map manual references to active user tokens). Ad-unlocked answers come as text and drawing, without voice, because voice is about 90% of our cost per question and one ad there pays well under a cent. Ads only run for users 18 and older, and never in the middle of an explanation.
Our costs (estimates): a question with voice costs about $0.027 (about $0.002 for Gemini 2.5 Flash plus $0.025 for ElevenLabs voice). Without voice, it costs about $0.002. A Plus user asking 10 questions a day costs us about $8 a month, so about half of $15.99 is gross margin.
Subscriptions: there are 845,712 international students in US degree programs. If 5% pay $159.90 a year (10 months of Plus), that’s about $6.8 million a year. Worldwide, about 6.9 million students study abroad; 5% of them at the same price is about $55 million a year. Beyond them, 1% of the world’s 264 million college students paying $2 a month is about $63 million a year.
Ads: if 100,000 free users in South Asia watch 3 ads a day, that’s about 9 million views a month. At $3 per 1,000 views, that’s about $27,000 a month in revenue against about $18,000 in model costs. Ads won’t be a big business for us. They keep students who can’t pay using neb, and some of them upgrade.
If you had any other ideas you considered applying with, please list them. One may be something we’ve been waiting for. Often when we fund people it’s to do something they list here and not in the main application.

Equity
Have you formed ANY legal entity yet?
This may be in the United States, in your home country or in another country.

Yes
No
If you have not formed the company yet, describe the planned equity ownership breakdown among the founders, employees and any other proposed stockholders. If there are multiple founders, be sure to give the proposed equity ownership of each founder and founder title (e.g. CEO). (This question is as much for you as us.)
Rubaiya, Rahbir and we have been working on projects for we spent more weekends than we can count at hackathons together, pulling all-nighters and shipping things that barely worked at 6am.That’s how we learned who does what: Me and Rahbir usually sketching the product and the story,and making it actually run, and Rubaiya is the one talking to people and keeping the three of us on track. Starting neb together felt obvious, and we split the company equally, a third each.
Have you taken any investment yet?
Yes
No
Are you currently fundraising?
Yes
No
Curious
What convinced you to apply to Y Combinator? Did someone encourage you to apply? Have you been to any YC events?

How did you hear about Y Combinator?

Batch Preference
What batch do you want to apply for?
How do or will you make money? How much could you make?
(We realize you can’t know precisely, but give your best estimate)

We make money from subscriptions, plus ads in lower-income markets.
In the US, Canada and Europe, neb is free for 15 questions a day, or $15.99 a month for neb Plus with a fair-use limit of 50 questions a day. For these Western markets, Stripe is already integrated to handle credit/debit card processing smoothly. We are also slowly moving towards integrating Upay to further expand local mobile financial service options alongside our primary channels.
In Bangladesh, India and similar markets, students get a smaller free cap. When they hit it, they can watch a short ad to unlock one more question, or pay a local price of about $2 a month. Because commercial banking isn't common for international credit or debit cards as many users refuse to pay bank charges they use bKash and Nagad, which allow them to pay easily using just their SIM card number. Since third-party payment aggregators like SSLCOMMERZ are too expensive at early stages, we handle this using a token reference system integrated directly into our forms and system architecture (similar to how streak platforms map manual references to active user tokens). Ad-unlocked answers come as text and drawing, without voice, because voice is about 90% of our cost per question and one ad there pays well under a cent. Ads only run for users 18 and older, and never in the middle of an explanation.
Our costs (estimates): a question with voice costs about $0.027 (about $0.002 for Gemini 2.5 Flash plus $0.025 for ElevenLabs voice). Without voice, it costs about $0.002. A Plus user asking 10 questions a day costs us about $8 a month, so about half of $15.99 is gross margin.
Subscriptions: there are 845,712 international students in US degree programs. If 5% pay $159.90 a year (10 months of Plus), that’s about $6.8 million a year. Worldwide, about 6.9 million students study abroad; 5% of them at the same price is about $55 million a year. Beyond them, 1% of the world’s 264 million college students paying $2 a month is about $63 million a year.
Ads: if 100,000 free users in South Asia watch 3 ads a day, that’s about 9 million views a month. At $3 per 1,000 views, that’s about $27,000 a month in revenue against about $18,000 in model costs. Ads won’t be a big business for us. They keep students who can’t pay using neb, and some of them upgrade.
If you had any other ideas you considered applying with, please list them. One may be something we’ve been waiting for. Often when we fund people it’s to do something they list here and not in the main application.

Equity
Have you formed ANY legal entity yet?
This may be in the United States, in your home country or in another country.

Yes
No
If you have not formed the company yet, describe the planned equity ownership breakdown among the founders, employees and any other proposed stockholders. If there are multiple founders, be sure to give the proposed equity ownership of each founder and founder title (e.g. CEO). (This question is as much for you as us.)
Rubaiya, Rahbir and we have been working on projects for we spent more weekends than we can count at hackathons together, pulling all-nighters and shipping things that barely worked at 6am.That’s how we learned who does what: Me and Rahbir usually sketching the product and the story,and making it actually run, and Rubaiya is the one talking to people and keeping the three of us on track. Starting neb together felt obvious, and we split the company equally, a third each.
Have you taken any investment yet?
Yes
No
Are you currently fundraising?
Yes
No
Curious
What convinced you to apply to Y Combinator? Did someone encourage you to apply? Have you been to any YC events?

How did you hear about Y Combinator?

Batch Preference
What batch do you want to apply for? 4. The student says **"save this"** (or presses **Ctrl + Alt + C**, or clicks **Save to
notebook**). 5. A small preview appears: the question crop **with the tutor's annotations on it**. The
student can adjust the crop and press **Save** (Enter) or **Cancel** (Esc). 6. A new notebook page opens with the question image and the tutor's annotations as **real,
editable ink strokes** on top. The student keeps working on it by hand.

### B. YouTube video

1. The student pauses a lecture on a diagram.
2. "What's going on in this diagram?"
3. The tutor annotates **beside the video player** (arrows into the frame, labels outside it so
   the diagram stays readable) and explains briefly.
4. "Save this" → preview of the video frame + annotations → Save.
5. The notebook page contains the frame, the annotations, and a source line: video title and a
   **link back to that timestamp** (e.g. `youtube.com/watch?v=…&t=754s`).

If the video is still playing, the tutor says "Pause it on the part you want" before capturing,
so the frame matches what they mean.

---

## 2. Overlay annotation

### 2.1 Actions

Boxes are `{left, top, right, bottom}` and points `{x, y}`, normalised 0–1000 across the
screenshot (Gemini's schema subset can't describe tuples).

```ts
type ScreenAction =
  | {
      type: "focus_region";
      box: Box;
      kind: "question" | "figure" | "video_frame" | "code" | "text";
    }
  | { type: "circle_region"; box: Box; label?: string }
  | { type: "underline"; box: Box }
  | { type: "highlight"; box: Box }
  | { type: "point_at"; point: Point; label?: string }
  | {
      type: "margin_note";
      text: string;
      besideBox: Box;
      side?: "left" | "right" | "below" | "auto";
    }
  | {
      type: "write_step";
      latexOrText: string;
      besideBox: Box;
      side?: "left" | "right" | "below" | "auto";
    }
  | { type: "clear" };
```

- Every response that annotates **must include one `focus_region`**. It anchors placement and
  becomes the default crop when saving.
- Keep text short: a margin note is a few words or one equation.

### 2.2 Placement "beside" content

1. Map boxes to screen coordinates (existing DPI/multi-monitor mapping).
2. Build an occupancy map from on-device OCR word boxes plus the `focus_region`.
3. `side: "auto"`: try right of the focus region, then left, then below; take the first area
   large enough at the current ink size that overlaps no text.
4. No free space: a **sticky-note card** (semi-opaque paper) at the nearest edge with a short
   arrow to the target.
5. Video: notes go **outside the player bounds** with arrows pointing in.
6. Ink size scales to the monitor DPI and the size of the surrounding text.

### 2.3 Keeping ink attached to content

- Watch the target window (`SetWinEventHook`: location, scrolling, foreground, minimise).
- On scroll, move, resize, minimise or app switch: **fade out** the ink within ~150 ms and keep
  the last annotation set in memory for 2 minutes.
- "Show that again" or the hotkey: re-capture and re-place the same annotations on the new
  layout.
- Esc clears ink at any time.

---

## 3. Save to notebook

### 3.1 Triggers

- Voice: "save this", "put this in my notebook", "clip this"
- Hotkey: **Ctrl + Alt + C**
- **Save to notebook** button
- With no annotation visible, Ctrl + Alt + C starts a **manual drag-select** clip instead.

### 3.2 Pipeline (all in Rust until the user confirms)

1. **Reuse the screenshot** from the annotation turn if the window hasn't changed since;
   otherwise capture again.
2. **Privacy filter** as in the main brief. Fail closed.
3. **Crop** to the `focus_region` expanded to include all annotation bounds plus 24 px padding;
   clamp to the captured window/monitor.
4. **Annotation strokes**: the overlay is excluded from capture, so the screenshot is clean.
   Take the ink as **vector strokes** and transform them into crop-relative coordinates. Do not
   burn them into the image.
5. **Preview window**: local-only, bundled assets, strict CSP, no network, filesystem or shell
   access; the image comes through a Rust custom protocol from memory (never a file); crop
   handles, "Include tutor notes" (on), "Include source link" (on for videos/web pages);
   Cancel or 60 s without a decision → discard everything.
6. **On Save**, Rust encodes the crop, uploads it with the device token, the server creates the
   clip, and the main app opens the new notebook page.

### 3.3 Source metadata

- `source_app` (exe name), `source_title` (window title, only for saved clips)
- Browsers: the address bar via UI Automation. YouTube: video URL + current timestamp (from the
  player, else read from the screenshot, else no timestamp). Other pages: page URL.
- The link is stored only if "Include source link" was on at save time.

### 3.4 Notebook representation

```ts
type ImageBlock = {
  id: string;
  pageId: string;
  type: "image";
  storagePath: string;
  width: number;
  height: number; // page units
  x: number;
  y: number;
  source?: { app: string; title?: string; url?: string; timestampSec?: number; capturedAt: string };
  ocrText?: string;
};
```

- Image block at the top with a source line beneath; tutor annotations become `Stroke`s with
  `author: "tutor"` and a shared `groupId` over the image; writing space below.
- `ocrText` goes into the notebook tutor's context.

### 3.5 Migrations

- `clips` with `source_title`, `source_url`, `source_timestamp_sec`, `width`, `height`,
  `ocr_text`; a private `clips` bucket with per-user path policies and signed URLs.

---

## 4. Prompts

- `screen_tutor` v2: always a `focus_region` when annotating; `margin_note` / `write_step`
  beside the focus region rather than on content; notes outside video players.
- `reanchor`: previous annotations + focus description + a new screenshot → updated boxes or
  `not_found`.
- The rule-based safety check covers every text field (`label`, `text`, `latexOrText`).

## 5. Security notes

- The preview window is the **only** place unconfirmed screenshot pixels reach a WebView. The
  main app and overlay never receive image bytes.
- Saved clips are user-confirmed content: private bucket, RLS, signed URLs, deleted with the
  account.
- Window titles and URLs are stored only for saved clips and never logged.
- Clipping a blocked app fails with a friendly message; nothing is captured.
- Protected video that captures as black: say "This video can't be captured".

## 6. Acceptance criteria

- [ ] PDF in Edge at 150% scaling: "help me with question 3" circles key terms and writes a hint
      **beside** it with no overlap of text.
- [ ] Same on a second monitor with different scaling.
- [ ] Scrolling the PDF fades the ink; "show that again" re-places it correctly.
- [ ] "Save this" shows a preview with crop + annotations; Save creates a notebook page with the
      image and **editable** violet strokes in the right positions.
- [ ] YouTube (paused): annotations outside the player with arrows in; the saved page has the
      frame, title and a working timestamp link.
- [ ] Cancel and timeout leave nothing on disk or in storage.
- [ ] Clip refused in a blocked app and in a password field.
- [ ] No screenshot bytes reach the main window or overlay WebView.
- [ ] Latency: "save this" → preview ≤ 400 ms (screenshot reused); Save → page open ≤ 2 s.

## 7. Tests

Placement (free space, sticky note, video rule); coordinate transforms (screen ↔ normalised ↔
crop ↔ page units across DPI and monitors); crop expansion and clamping; WinEvent invalidation;
YouTube URL + timestamp builder; black-frame detection; RLS and storage policies for clips.
