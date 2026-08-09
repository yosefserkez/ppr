/**
 * What the memory layer is expected to do, as checkable cases.
 *
 * These measure a *model plus a prompt*, which unit tests deliberately cannot:
 * the test suite scripts the model so behaviour is pinned, and that is the only
 * way to test the plumbing. Everything the plumbing hands to a model — does it
 * split a compound sentence, does it refuse to invent a year, does it notice
 * "Sam owns auth" and "Sam is responsible for authentication" are one fact — is
 * unmeasured by definition until something like this runs.
 *
 * Rules for writing a case:
 * - Assert on meaning, never on wording. `must` is a set of words that have to
 *   appear somewhere in one fact; the model may phrase the rest how it likes.
 * - Every case says what would be *wrong*, not only what would be right. A
 *   suite that only measures recall rewards a model that extracts everything.
 * - Keep entries realistic. A model handles "the staging database is postgres
 *   14" differently from "x is 1", and only one of those is a note anyone wrote.
 *
 * Fields:
 *   rounds[]        learn is run once per round, in order, on one vault
 *     entries[]     {name, text} — `name` is how `from` refers back to it
 *     expect        facts / forbid / total / learned / refined / conflicts / duplicates
 *   ask[]           questions asked after the last round
 *   remind[]        {say, now, expectDate, expectText} — one typed line read by
 *                   `reminderFrom` against a pinned today. `expectDate: null`
 *                   asserts that no day was read out of it.
 *   brief           {now, items[], says[]} — dated items, then the phrasing of
 *                   the heads-up. `says[]` is {name, all, any}: every term in
 *                   `all`, and at least one of the term-sets in `any`.
 *
 * Counts accept a number or a [min, max] range. Ranges are for cases where a
 * defensible model could reasonably return either.
 */

export const CASES = [
  // ---------------------------------------------------------- decomposition
  {
    name: 'a compound sentence becomes one fact per idea',
    dimension: 'decomposition',
    rounds: [
      {
        entries: [
          { name: 'note', text: "My girlfriend Emily's birthday is october 20 2002 and she likes chocolate" },
        ],
        expect: {
          facts: [
            { must: ['emily', 'girlfriend'] },
            { must: ['emily', 'birthday'], date: '2002-10-20', recurs: 'yearly' },
            { must: ['emily', 'chocolate'] },
          ],
          total: [3, 4],
        },
      },
    ],
  },
  {
    name: 'each fact stands alone, without pronouns to resolve',
    dimension: 'decomposition',
    rounds: [
      {
        entries: [
          { name: 'note', text: 'Sam runs the auth service. He prefers to be paged on Signal, not email.' },
        ],
        expect: {
          facts: [{ must: ['sam', 'auth'] }, { must: ['sam', 'signal'] }],
          // "He prefers Signal" is useless read cold in a year.
          forbid: [['he prefers']],
        },
      },
    ],
  },

  {
    // The other half of decomposition, and the one the prompt used to get
    // wrong. "One idea per fact, always" was obeyed literally on real entries:
    // a single preference written as a list came back as three fragments that
    // each said almost nothing, and the store filled up with them.
    name: 'a list of facets of one preference stays one fact',
    dimension: 'decomposition',
    rounds: [
      {
        entries: [
          {
            name: 'note',
            text: 'Thinking about money again. My financial goals are to save aggressively, invest in index funds, and grow long-term wealth. Spent an hour in the spreadsheet and got nowhere.',
          },
        ],
        expect: {
          // The whole list survives in one fact. Split three ways, no fragment
          // would carry both of these, which is what makes this the check.
          facts: [{ must: ['index', 'wealth'] }],
          forbid: [['spreadsheet']],
          // Three facts here is the failure, not a stricter reading of one.
          total: [1, 2],
        },
      },
    ],
  },

  // ---------------------------------------------------------------- recall
  {
    // The case that would have caught the lossy backfill. Every earlier case
    // hands the model one or two entries, which is the size at which nothing
    // can go wrong: the reply fits any output budget and every entry gets the
    // model's full attention. A real day does not look like that. 29 entries
    // were read as roughly two thirds of themselves for weeks, and the suite
    // scored 100% throughout, because no case was ever big enough to notice.
    //
    // Eight entries, deliberately over EXTRACT_CHUNK_CHARS so the batch spans
    // more than one extraction call. Each carries exactly one durable fact
    // about a different person, service, or tool, so nothing here can be
    // reconciled away — a missing fact means an entry was not read.
    name: 'a day of entries too big for one prompt loses none of them',
    dimension: 'recall',
    rounds: [
      {
        entries: [
          {
            name: 'sync',
            text: `Team sync ran long again. The one thing worth keeping: Priya has moved to the Berlin office for good, so our overlap window is down to about three hours a day. Spent the rest of the morning on that flaky snapshot test that only fails in CI, still no idea why. Cleared the review queue at least, which took longer than it should have. Coffee machine on the third floor is broken again and nobody has called anyone about it. Tomorrow is mostly meetings, unfortunately.`,
          },
          {
            name: 'postmortem',
            text: `Incident postmortem this afternoon, mostly calm, nobody got blamed. Marcus is the on-call lead for Checkout now that the rota was redrawn, so pages about payments go to him first. The write-up is half done and I want to finish it before Friday. Feeling a bit fried after two days of this. Reminder to myself to actually take a lunch break tomorrow instead of eating at the desk again while reading dashboards.`,
          },
          {
            name: 'design',
            text: `Long design review, three hours with a break in the middle. The shared component library finally has a name — it is called Halyard, and that is what we will refer to in docs and tickets from here on. Bikeshedding took forty minutes, which is about what I expected given the number of people in the room. Still owe them a decision on the icon set. Went for a walk after, which helped. Tired but it was worth it in the end.`,
          },
          {
            name: 'infra',
            text: `Infrastructure planning session, the second one this month. We are standardising on Terraform for all environment provisioning — the mix of hand-rolled scripts and console clicking has cost us an outage twice this quarter. Migration will take a while and I have not scoped it yet. Also spent an hour fighting a VPN issue that turned out to be my own DNS. Nothing else of note today, quiet otherwise, which was a relief.`,
          },
          {
            name: 'dinner',
            text: `Planning the team dinner for next month and it is harder than it should be. Anna is allergic to shellfish, so wherever we book has to have something else on the menu she can eat. Three venues shortlisted, no decision yet. Otherwise a slow day — mostly triage, a couple of small pull requests, and a long thread about whether we need another standup. We do not. Head is a bit foggy today, might be the weather.`,
          },
          {
            name: 'costs',
            text: `Cost review with finance, slides and everything. Our staging cluster is hosted in AWS eu-west-1, which is the thing I keep having to look up, so writing it down here. The bill is higher than expected but most of it is the search tier and that is being replaced anyway. Half of the afternoon went on a spreadsheet nobody will read twice. Weather was grim. Nothing shipped today, which is fine, it was that kind of day.`,
          },
          {
            name: 'integration',
            text: `Caught up with Tomas about the integration work, first proper conversation in weeks. He prefers to be contacted on Telegram rather than email, which explains why my last two messages sat unanswered for a week and a half. The integration itself is maybe a third done and blocked on their side. Grabbed lunch after. Meant to write up the API notes this evening but ran out of energy, so it moves to tomorrow.`,
          },
          {
            name: 'docs',
            text: `Documentation cleanup day, which I had been putting off. The company wiki has moved from Confluence to Notion, and the old space is read-only from now on, so any link I find in an old ticket needs updating by hand. Moved about twenty pages before I got bored. The search is better, the editor is worse. Also had a dentist appointment which ate most of the morning and I am still numb on one side.`,
          },
        ],
        expect: {
          facts: [
            { must: ['priya', 'berlin'] },
            { must: ['marcus', 'checkout'] },
            { must: ['halyard'] },
            { must: ['terraform'] },
            { must: ['anna', 'shellfish'] },
            { must: ['eu-west-1'] },
            { must: ['tomas', 'telegram'] },
            { must: ['notion'] },
          ],
          // The filler is the other half of the measurement: a model that
          // survives eight entries by keeping everything has not passed.
          forbid: [['coffee'], ['dentist'], ['bikeshedding'], ['vpn']],
          // Eight is the floor. A handful more is defensible — "the old
          // Confluence space is read-only" is a real fact — but a number well
          // above that means the entries were shattered rather than read.
          total: [8, 13],
        },
      },
    ],
  },

  // ------------------------------------------------------------- precision
  {
    name: 'a day of status updates yields nothing durable',
    dimension: 'precision',
    rounds: [
      {
        entries: [
          {
            name: 'note',
            text: 'Tired today. Standup at 10 went fine. Still chasing that flaky test in the billing suite, no luck yet. Lunch with the team.',
          },
        ],
        expect: {
          total: [0, 1],
          forbid: [['tired'], ['standup'], ['lunch'], ['flaky', 'chasing']],
        },
      },
    ],
  },
  {
    name: 'the durable half of a mixed entry is kept and the rest dropped',
    dimension: 'precision',
    rounds: [
      {
        entries: [
          {
            name: 'note',
            text: 'Rough morning, slept badly. Decided we are standardising on pnpm across all repos — npm workspaces kept breaking the CI cache. Need coffee.',
          },
        ],
        expect: {
          facts: [{ must: ['pnpm'] }],
          forbid: [['slept'], ['coffee'], ['morning']],
          total: [1, 3],
        },
      },
    ],
  },

  // ------------------------------------------------------------ provenance
  {
    name: 'each fact points at the entry it actually came from',
    dimension: 'provenance',
    rounds: [
      {
        entries: [
          { name: 'people', text: 'Rae took over the billing service from Sam last week.' },
          { name: 'infra', text: 'We moved the search index to Typesense. Elastic was costing too much.' },
        ],
        expect: {
          facts: [
            { must: ['rae', 'billing'], from: 'people' },
            { must: ['typesense'], from: 'infra' },
          ],
        },
      },
    ],
  },

  // ------------------------------------------------------------------ dates
  {
    name: 'a birthday is dated and recurs',
    dimension: 'dates',
    rounds: [
      {
        entries: [{ name: 'note', text: "Mum's birthday is the 3rd of March, she was born in 1958" }],
        expect: { facts: [{ must: ['birthday'], date: '1958-03-03', recurs: 'yearly' }] },
      },
    ],
  },
  {
    name: 'a deadline is dated and does not recur',
    dimension: 'dates',
    rounds: [
      {
        entries: [{ name: 'note', text: 'The office lease runs out on 30 June 2027 and we have not decided whether to renew.' }],
        expect: { facts: [{ must: ['lease'], date: '2027-06-30', recurs: null }] },
      },
    ],
  },
  {
    name: 'a birthday with no year still recurs',
    dimension: 'dates',
    rounds: [
      {
        entries: [{ name: 'note', text: 'Note to self: Priya’s birthday is the 12th of September.' }],
        // No year was given, so 0000 records that rather than guessing one.
        expect: { facts: [{ must: ['priya', 'birthday'], date: '0000-09-12', recurs: 'yearly' }] },
      },
    ],
  },
  {
    name: 'a year that was never given is not invented',
    dimension: 'dates',
    rounds: [
      {
        entries: [{ name: 'note', text: 'Emily likes dark chocolate, 70% or higher.' }],
        // A date here would be fabricated, and everything downstream trusts it.
        expect: { facts: [{ must: ['chocolate'], date: null }] },
      },
    ],
  },

  // ----------------------------------------------------------- reconciliation
  {
    name: 'reading the same entry twice adds nothing',
    dimension: 'reconciliation',
    rounds: [
      {
        entries: [{ name: 'a', text: 'Sam owns the auth service.' }],
        expect: { learned: [1, 2] },
      },
      {
        entries: [{ name: 'b', text: 'Sam owns the auth service.' }],
        expect: { learned: 0, total: [1, 2] },
      },
    ],
  },
  {
    name: 'the same fact in different words is recognised as the same fact',
    dimension: 'reconciliation',
    rounds: [
      {
        entries: [{ name: 'a', text: 'Sam owns the auth service.' }],
        expect: { learned: [1, 2] },
      },
      {
        entries: [{ name: 'b', text: 'Authentication is Sam’s responsibility.' }],
        // The exact-match floor cannot catch this one; only the model can.
        expect: { learned: 0, total: [1, 2] },
      },
    ],
  },
  {
    // One run, two entries, one fact worded two ways — which was structurally
    // impossible to pass until reconciliation started asking about a
    // candidate's siblings as well as about the known facts. `factKey` cannot
    // see it (the sentences differ), and there is no second run to catch it.
    name: 'one fact said twice in one run is stored once',
    dimension: 'reconciliation',
    rounds: [
      {
        entries: [
          { name: 'standup', text: 'Standup: Nadia has taken over the release runbook, so release questions go to her now.' },
          { name: 'handover', text: 'Finished the handover notes. Maintaining the release runbook is Nadia’s job from here on.' },
        ],
        expect: { total: [1, 2] },
      },
    ],
  },
  {
    name: 'a more precise version replaces the vaguer one',
    dimension: 'reconciliation',
    rounds: [
      {
        entries: [{ name: 'a', text: 'Emily likes chocolate.' }],
        expect: { learned: [1, 2] },
      },
      {
        entries: [{ name: 'b', text: 'To be specific, Emily only likes dark chocolate, 70% cocoa or higher.' }],
        expect: { total: [1, 2], facts: [{ must: ['dark', 'chocolate'] }] },
      },
    ],
  },
  {
    name: 'a reversed decision is flagged, not silently applied',
    dimension: 'reconciliation',
    rounds: [
      {
        entries: [{ name: 'a', text: 'The staging database is on Postgres 14.' }],
        expect: { learned: [1, 2] },
      },
      {
        entries: [{ name: 'b', text: 'Correction: staging was upgraded, it is on Postgres 16 now.' }],
        // Either verdict is defensible; silently dropping the old one is not.
        expect: { total: [1, 2], facts: [{ must: ['16'] }] },
      },
    ],
  },
  {
    name: 'two different facts about one person are both kept',
    dimension: 'reconciliation',
    rounds: [
      {
        entries: [{ name: 'a', text: 'Emily likes chocolate.' }],
        expect: { learned: [1, 2] },
      },
      {
        entries: [{ name: 'b', text: 'Emily moved to Berlin in the spring.' }],
        // Same subject, different property. Collapsing these loses one.
        expect: { learned: [1, 2], facts: [{ must: ['chocolate'] }, { must: ['berlin'] }] },
      },
    ],
  },

  // --------------------------------------------------------------- retrieval
  {
    name: 'a question is answered from a fact that shares no keywords with it',
    dimension: 'retrieval',
    rounds: [
      {
        entries: [
          { name: 'a', text: "Emily's birthday is 20 October. She likes dark chocolate." },
          { name: 'b', text: 'Spent the morning rewriting the CSV importer.' },
        ],
        expect: {},
      },
    ],
    ask: [
      {
        question: 'what should I get Emily?',
        must: [['chocolate']],
      },
    ],
  },
  {
    name: 'a question nothing covers is answered with "I do not know"',
    dimension: 'retrieval',
    rounds: [
      {
        entries: [{ name: 'a', text: 'Emily likes dark chocolate.' }],
        expect: {},
      },
    ],
    ask: [
      {
        question: 'what car does Emily drive?',
        // Anything naming a car here is invented, which is the failure that
        // makes a memory layer unusable by another tool.
        mustNot: [['toyota'], ['honda'], ['tesla'], ['bmw'], ['ford']],
        // Every honest way to say it: "I do not know", "I don't know",
        // "nothing here mentions that", "there is no information about it",
        // "I don't have information about that" — the last one scored as a
        // failure to refuse, which measured this list rather than the model.
        must: [
          ['not', 'know'],
          ["don't", 'know'],
          ['nothing'],
          ['no ', 'information'],
          ['no ', 'mention'],
          ["don't have"],
          ['do not have'],
          ['not specified'],
          ['unknown'],
          ['not say'],
        ],
        anyMust: true,
      },
    ],
  },

  // --------------------------------------------------------------- reminders
  //
  // The reminder path is deterministic first: `remind.ts` reads the day out of
  // a line with no model, and `core/test/remind.test.js` pins that half with a
  // fixed `now`. What it cannot pin is the other half — the lines it gives up
  // on, which are handed to a model. Every `say` below is one of those, so
  // each case measures the prompt rather than the parser. `now` is a Saturday,
  // which matters for the weekday case.
  {
    name: 'a date described by counting back from the end of a month',
    dimension: 'reminders',
    remind: [
      {
        say: 'file expenses two days before the end of the month',
        now: '2026-08-08',
        expectDate: '2026-08-29',
        expectText: ['expenses'],
      },
    ],
  },
  {
    name: 'a weekday in the middle of a sentence means the next one',
    dimension: 'reminders',
    remind: [
      {
        // Not today, and not the Monday that has gone: "on monday" is buried
        // mid-sentence, so nothing deterministic will find it.
        say: 'chase the invoice on monday morning before standup',
        now: '2026-08-08',
        expectDate: '2026-08-10',
        expectText: ['invoice'],
      },
    ],
  },
  {
    name: 'a duration spelled out in words is still a duration',
    dimension: 'reminders',
    remind: [
      {
        // `in 2 weeks` is arithmetic ppr does itself; `in two weeks` is not.
        say: 'in two weeks check whether the trial licence is still needed',
        now: '2026-08-08',
        expectDate: '2026-08-22',
        expectText: ['trial'],
      },
    ],
  },
  {
    name: 'an explicit date is taken exactly, year and all',
    dimension: 'reminders',
    remind: [
      {
        say: 'send the figures for the audit on 3 March 2027, first thing',
        now: '2026-08-08',
        expectDate: '2027-03-03',
        expectText: ['figures'],
      },
    ],
  },
  {
    name: 'a line with no time in it is given no day',
    dimension: 'reminders',
    remind: [
      {
        // A guessed day is worse than none: the words are kept as a log
        // either way, and only one of those outcomes wakes the user up on a
        // day they never named.
        say: 'ask Nadia about the icon set',
        now: '2026-08-08',
        expectDate: null,
      },
    ],
  },
  {
    name: 'a question about the past is not a thing to be scheduled',
    dimension: 'reminders',
    remind: [
      {
        // "remind me" without a future in it. The reminder path is reached by
        // the word, so the model is the only thing that can decline — and
        // declining means no date, which files it as the note it always was.
        say: 'remind me why I dropped redis',
        now: '2026-08-08',
        expectDate: null,
      },
    ],
  },

  // ------------------------------------------------------------------- brief
  {
    // Which items are due is arithmetic, settled before any model runs, so the
    // only thing measurable here is the phrasing: an intention that did not
    // happen has to be named as one, or the brief reads like a to-do list.
    name: 'an overdue item is named as overdue, a future one counted down to',
    dimension: 'brief',
    brief: {
      now: '2026-08-08',
      items: [
        { text: 'file the Q2 expenses', date: '2026-08-05' },
        { text: 'renew the halyard.dev domain', date: '2026-08-20' },
      ],
      says: [
        {
          name: 'says the expenses are late',
          all: ['expenses'],
          any: [['overdue'], ['late'], ['days ago'], ['past due'], ['was due'], ['missed']],
        },
        {
          name: 'counts down to the renewal',
          // The name, not the word "domain": the model is free to write
          // "renew halyard.dev", and it is the countdown being measured here.
          all: ['halyard'],
          any: [['12 days'], ['12'], ['two weeks'], ['20 august'], ['aug 20']],
        },
      ],
    },
  },
];
