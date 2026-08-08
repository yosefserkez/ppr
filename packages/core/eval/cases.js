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
        // "nothing here mentions that", "there is no information about it".
        must: [
          ['not', 'know'],
          ["don't", 'know'],
          ['nothing'],
          ['no ', 'information'],
          ['no ', 'mention'],
          ['not say'],
        ],
        anyMust: true,
      },
    ],
  },
];
