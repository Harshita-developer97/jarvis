import { ShieldOff } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { jarvisApi } from '../lib/api';

export function BusinessView() {
  const [summary, setSummary] = useState<any | null>(null);
  const [records, setRecords] = useState<any[]>([]);
  const [domainFilter, setDomainFilter] = useState('all');
  const [ownerAbsence, setOwnerAbsence] = useState<any | null>(null);

  const [domain, setDomain] = useState<'sales' | 'marketing' | 'finance' | 'hr' | 'operations'>('sales');
  const [recordType, setRecordType] = useState('lead');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');

  const [simName, setSimName] = useState('');
  const [simCost, setSimCost] = useState('1200');
  const [simLift, setSimLift] = useState('18');
  const [simOutput, setSimOutput] = useState<any | null>(null);

  const [decisionResult, setDecisionResult] = useState<any | null>(null);

  const loadAll = async (dom = domainFilter) => {
    const [biz, abs] = await Promise.all([
      jarvisApi.getBusiness(dom),
      jarvisApi.getOwnerAbsence(),
    ]);
    setSummary(biz.summary);
    setRecords(biz.records || []);
    setOwnerAbsence(abs);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleAddRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await jarvisApi.createBusinessRecord({
      domain,
      recordType,
      title: title.trim(),
      amount: amount ? Number(amount) : null,
      status: 'active',
    });
    setTitle('');
    setAmount('');
    await loadAll();
  };

  const handleRunSimulation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simName.trim()) return;
    const res = await jarvisApi.runSimulation({
      domain: 'business',
      scenarioName: simName.trim(),
      assumptions: {
        monthlyCost: Number(simCost) || 1000,
        expectedLiftPercent: Number(simLift) || 15,
        complexityFactor: 1.25,
      },
    });
    setSimOutput(res);
  };

  const handleRunSampleDecision = async () => {
    const res = await jarvisApi.evaluateDecision({
      objective: 'Select primary local inference strategy for 8GB hardware',
      alternatives: [
        { name: 'Quantized 3B Local Model (Ollama Q4)', cost: 0, timeHours: 1, riskScore: 2, benefitScore: 8, reversible: true },
        { name: 'Cloud API Only', cost: 25, timeHours: 0.5, riskScore: 5, benefitScore: 9, reversible: true },
        { name: 'Unquantized 13B CPU Inference', cost: 0, timeHours: 3, riskScore: 8, benefitScore: 4, reversible: true },
      ],
    });
    setDecisionResult(res);
  };

  return (
    <div className="space-y-6 p-6">
      {/* Real Financial & Pipeline Ledger Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Sales Pipeline</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[#1F2937] tabular-nums">
            ${summary?.salesPipelineValue ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            Active leads: {summary?.activeLeads ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Recorded Revenue</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[#16A34A] tabular-nums">
            ${summary?.recordedRevenue ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500">Verified ledger entries only</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">Recorded Expenses</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[#1F2937] tabular-nums">
            ${summary?.recordedExpenses ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            Net Cash Flow: ${summary?.netCashFlow ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">HR &amp; Marketing</div>
          <div className="mt-1 font-mono text-xl font-semibold text-[#1F2937] tabular-nums">
            {summary?.hrCandidates ?? 0} / {summary?.campaignsCount ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500">Candidates / Campaigns</div>
        </div>
      </div>

      {/* Owner Absence Mode Control */}
      {ownerAbsence && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-5">
          <div>
            <h2 className="font-display text-base font-semibold text-[#1F2937]">
              Owner Absence Autonomous Mode
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Status: {ownerAbsence.enabled ? 'Enabled' : 'Disabled'} · Spending limit: $
              {ownerAbsence.spendingLimitUsd} · Max window: {ownerAbsence.maxDurationHours}h ·
              Restricted: {ownerAbsence.restrictedActions?.join(', ')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                void jarvisApi
                  .updateOwnerAbsence({ enabled: !ownerAbsence.enabled, emergencyStopped: false })
                  .then(setOwnerAbsence)
              }
              className={`rounded-md px-3.5 py-2 text-xs font-semibold ${
                ownerAbsence.enabled
                  ? 'border border-slate-200 bg-white text-[#1F2937]'
                  : 'bg-[#1F2937] text-white'
              }`}
            >
              {ownerAbsence.enabled ? 'Disable Absence Mode' : 'Enable Absence Mode'}
            </button>
            <button
              type="button"
              onClick={() =>
                void jarvisApi
                  .updateOwnerAbsence({ enabled: false, emergencyStopped: true })
                  .then(setOwnerAbsence)
              }
              className="flex items-center gap-1 rounded-md bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700"
            >
              <ShieldOff className="h-3.5 w-3.5" />
              <span>Emergency Stop</span>
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Create Real Business Record */}
        <form
          onSubmit={handleAddRecord}
          className="rounded-lg border border-slate-200 bg-white p-5"
        >
          <h3 className="font-display text-base font-semibold text-[#1F2937]">
            Log Business Record
          </h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value as any)}
              className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
            >
              <option value="sales">Sales / CRM</option>
              <option value="marketing">Marketing</option>
              <option value="finance">Finance</option>
              <option value="hr">HR / Recruitment</option>
              <option value="operations">Operations</option>
            </select>
            <select
              value={recordType}
              onChange={(e) => setRecordType(e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
            >
              <option value="lead">Lead / Deal</option>
              <option value="revenue">Revenue</option>
              <option value="expense">Expense</option>
              <option value="campaign">Campaign</option>
              <option value="candidate">HR Candidate</option>
              <option value="workflow">Operational Workflow</option>
            </select>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Record title or client name..."
              className="rounded-md border border-slate-200 px-3 py-2 text-sm sm:col-span-2 focus:border-[#FF7A00] focus:outline-none"
            />
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount USD (optional)"
              className="rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-[#FF7A00] focus:outline-none"
            />
            <button
              type="submit"
              disabled={!title.trim()}
              className="rounded-md bg-[#FF7A00] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e56d00] disabled:opacity-40"
            >
              Save Record
            </button>
          </div>
        </form>

        {/* Digital Twin & Decision Engine */}
        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-[#1F2937]">
              Digital Twin &amp; Decision Engine
            </h3>
            <button
              type="button"
              onClick={() => void handleRunSampleDecision()}
              className="rounded border border-slate-200 px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
            >
              Run Decision Matrix
            </button>
          </div>
          <form onSubmit={handleRunSimulation} className="grid gap-2 sm:grid-cols-3">
            <input
              value={simName}
              onChange={(e) => setSimName(e.target.value)}
              placeholder="Scenario name..."
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs sm:col-span-3"
            />
            <input
              type="number"
              value={simCost}
              onChange={(e) => setSimCost(e.target.value)}
              placeholder="Base cost"
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs"
            />
            <input
              type="number"
              value={simLift}
              onChange={(e) => setSimLift(e.target.value)}
              placeholder="Lift %"
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs"
            />
            <button
              type="submit"
              className="rounded-md bg-[#1F2937] px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              Simulate
            </button>
          </form>
          {simOutput && (
            <div className="rounded border border-amber-200 bg-amber-50/50 p-2.5 text-xs text-slate-700">
              {simOutput.predictedOutcome}
            </div>
          )}
          {decisionResult && (
            <div className="rounded border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700">
              <div className="font-semibold">Recommended: {decisionResult.recommended}</div>
              <div className="mt-0.5">{decisionResult.reasoningSummary}</div>
            </div>
          )}
        </div>
      </div>

      {/* Business Records Table */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="font-display text-sm font-semibold text-[#1F2937]">
            Business Records ({records.length})
          </h3>
          <select
            value={domainFilter}
            onChange={(e) => {
              setDomainFilter(e.target.value);
              void loadAll(e.target.value);
            }}
            className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs"
          >
            <option value="all">All Domains</option>
            <option value="sales">Sales</option>
            <option value="marketing">Marketing</option>
            <option value="finance">Finance</option>
            <option value="hr">HR</option>
            <option value="operations">Operations</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Domain</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {records.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-5 text-slate-500">
                    No business records logged yet.
                  </td>
                </tr>
              ) : (
                records.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5 font-medium text-[#1F2937]">{r.title}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.domain}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.recordType}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.status}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[#1F2937]">
                      {r.amount !== null ? `$${r.amount}` : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
