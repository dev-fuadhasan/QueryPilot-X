"use client";

import { ArrowRight, BarChart3, Check, Database, FileText, LockKeyhole, ShieldCheck, BellRing, CalendarDays } from "lucide-react";

type LandingPageProps = {
  onStart: () => void;
};

const features = [
  {
    index: "01",
    title: "AI-powered business analysis",
    detail: "Ask questions in plain language, explore approved datasets, inspect SQL-backed results and build customizable charts and dashboards.",
    image: "/landing/smart-dashboard.svg",
    alt: "Illustration of a customizable analytics dashboard"
  },
  {
    index: "02",
    title: "Automated business reporting",
    detail: "Daily and weekly reporting, scheduled KPI reviews, sales comparisons, saved report history, and shareable HTML or PDF summaries.",
    image: "/landing/daily-reports.svg",
    alt: "Illustration of a calendar and business performance report"
  },
  {
    index: "03",
    title: "Fraud monitoring & alerts",
    detail: "Spot unusual transactions, record changes and suspicious activity, with database audit trails and email alerts for important events.",
    image: "/landing/fraud-detection.svg",
    alt: "Illustration of a security shield with monitored events"
  }
];

export default function LandingPage({ onStart }: LandingPageProps) {
  function startConnection() {
    onStart();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  return (
    <div className="qp-site-landing">
      <section className="qp-land-section qp-land-overview" aria-labelledby="qp-land-heading">
        <div className="qp-land-heading-block">
          <span className="qp-land-eyebrow"><span className="qp-land-eyebrow-line" /> BUILT FOR CLEARER DECISIONS</span>
          <h2 id="qp-land-heading">One workspace.<br /><span>Every important perspective.</span></h2>
          <p>Analyze business data, schedule performance reviews, monitor important changes, and bring meaningful notifications into one connected experience.</p>
        </div>

        <div className="qp-land-feature-grid">
          {features.map((feature) => (
            <article className="qp-land-feature-card" key={feature.index}>
              <div className="qp-land-feature-art">
                <img src={feature.image} alt={feature.alt} width={800} height={600} loading="lazy" decoding="async" />
              </div>
              <div className="qp-land-feature-copy">
                <span className="qp-land-feature-index">{feature.index} / CORE WORKSPACE</span>
                <h3>{feature.title}</h3>
                <p>{feature.detail}</p>
              </div>
            </article>
          ))}
        </div>
        <div className="qp-land-capability-strip" aria-label="QueryPilot features">
          <span><BarChart3 size={17} /> Natural-language insights</span>
          <span><CalendarDays size={17} /> Daily &amp; weekly schedules</span>
          <span><FileText size={17} /> HTML &amp; PDF reports</span>
          <span><BellRing size={17} /> Email &amp; threshold alerts</span>
        </div>
      </section>

      <section className="qp-land-section qp-land-ai" aria-labelledby="qp-land-ai-heading">
        <div className="qp-land-ai-copy">
          <span className="qp-land-eyebrow"><span className="qp-land-eyebrow-line" /> ASK AI</span>
          <h2 id="qp-land-ai-heading">Ask the question.<br /><span>Explore the evidence.</span></h2>
          <p>Turn natural-language questions into data-backed answers. Explore trends, drill into selected tables and see the SQL, visualizations and explanations behind each result.</p>
          <ul className="qp-land-proof-list">
            <li><span><Database size={17} /></span><div><strong>Choose your dataset</strong><small>Keep the analysis focused on the tables that matter.</small></div></li>
            <li><span><BarChart3 size={17} /></span><div><strong>Ask in plain language</strong><small>Explore metrics without manually writing each query.</small></div></li>
            <li><span><Check size={17} /></span><div><strong>Inspect the result</strong><small>Review the supporting SQL, tables, charts and exportable reports.</small></div></li>
          </ul>
        </div>
        <div className="qp-land-ai-art">
          <img src="/landing/ask-ai.svg" alt="QueryPilot AI question translated into read-only SQL and data-backed charts" width={800} height={600} loading="lazy" decoding="async" />
        </div>
      </section>

      <section className="qp-land-section qp-land-process" aria-labelledby="qp-land-process-heading">
        <div className="qp-land-process-intro">
          <span className="qp-land-eyebrow"><span className="qp-land-eyebrow-line" /> HOW IT WORKS</span>
          <h2 id="qp-land-process-heading">From connection to clarity.</h2>
          <p>From a secure data connection to insights, recurring reports and timely alerts.</p>
        </div>
        <div className="qp-land-steps">
          <div className="qp-land-step">
            <span className="qp-land-step-icon"><Database size={22} strokeWidth={1.7} /></span>
            <span className="qp-land-step-number">STEP 01</span>
            <h3>Connect</h3>
            <p>Authorize your Supabase project and choose the data you want to explore.</p>
          </div>
          <div className="qp-land-step">
            <span className="qp-land-step-icon"><FileText size={22} strokeWidth={1.7} /></span>
            <span className="qp-land-step-number">STEP 02</span>
            <h3>Understand</h3>
            <p>Build dashboards, compare business metrics and schedule daily or weekly reports.</p>
          </div>
          <div className="qp-land-step">
            <span className="qp-land-step-icon"><ShieldCheck size={22} strokeWidth={1.7} /></span>
            <span className="qp-land-step-number">STEP 03</span>
            <h3>Stay informed</h3>
            <p>Keep track of report history, database changes and email notifications for unusual activity or KPI drops.</p>
          </div>
        </div>
      </section>

      <section className="qp-land-final" aria-label="Start using QueryPilot">
        <div className="qp-land-final-copy">
          <span className="qp-land-final-kicker">YOUR DATA. A CLEARER VIEW.</span>
          <h2>Make every decision<br />a little more informed.</h2>
          <p>Bring analytics, scheduled reporting and intelligent alerts together in one place.</p>
          <button type="button" onClick={startConnection} className="qp-land-final-button">
            Get started <ArrowRight size={18} />
          </button>
          <div className="qp-land-final-note"><LockKeyhole size={14} /> Supabase authorization required</div>
        </div>
        <div className="qp-land-final-accent" aria-hidden="true">
          <div className="qp-land-final-accent-ring">
            <BarChart3 size={84} strokeWidth={1.1} />
          </div>
        </div>
      </section>

      <footer className="qp-land-footer">
        <span className="qp-land-footer-brand"><img src="/querypilot-logo.svg" alt="" width={26} height={26} /> Query<strong>Pilot</strong></span>
        <span>Data made clear.</span>
        <span>Built around your connected data.</span>
      </footer>
    </div>
  );
}
