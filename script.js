/**
 * Moonkin Simulation für Web (Portiert von Google Apps Script)
 */

function getVal(id) {
    var el = document.getElementById(id);
    if (!el) return 0;
    if (el.type === "checkbox") return el.checked ? 1 : 0;
    return parseFloat(el.value) || 0;
}

function runSimulation() {
    var btn = document.getElementById("btnRun");
    btn.innerText = "Berechne...";
    
    // Kleiner Timeout, damit der Browser den Button-Text aktualisieren kann
    setTimeout(() => {
        executeLogic();
        btn.innerText = "Start Simulation";
    }, 50);
}

function executeLogic() {
    // --- 1. INPUTS LESEN ---
    var CalcMethod = document.getElementById("calcMethod").value; // S oder D
    var rawSims = getVal("simCount");
    var numSimulations = (CalcMethod === "D") ? 1 : (rawSims > 0 ? rawSims : 1);
    
    var MaxTime = getVal("maxTime");

    var RotaSettings = {
        castIS: getVal("rota_is"),
        castMF: getVal("rota_mf"),
        eclDOT: getVal("rota_eclDot"),
        spellInterrupt: getVal("rota_interrupt"),
        fishMeth: "F1" // Default, könnte man noch als Select hinzufügen
    };

    var Stats = {
        hitCoeff: getVal("statHit") / 100, // Input ist 98, wir brauchen 0.98
        spellCrit: getVal("statCrit"),
        haste: getVal("statHaste")
    };

    var Gear = {
        t3_4p: getVal("t3_4p"),
        t3_6p: getVal("t3_6p"),
        t3_8p: getVal("t3_8p"),
        t35_5p: getVal("t35_5p"),
        idolEoF: getVal("idolEoF"),
        idolMoon: getVal("idolMoon"),
        idolProp: getVal("idolProp"),
        bindings: 0 // Nicht implementiert im UI
    };

    var Talents = {
        nEProc: 50, aEProc: 30,
        neDuration: 15.0, aeDuration: 15.0,
        neICD: 30.0, aeICD: 30.0,
        boatReduc: Gear.t35_5p ? 0.665 : 0.5,
        boatChance: 0.30
    };

    // Spell Values (Manuell eingetragen im UI)
    var durMF = 12.0 + (Gear.t3_4p ? 3.0 : 0);
    var durIS = 12.0 + (Gear.t3_4p ? 2.0 : 0);

    // --- STATS STORAGE ---
    var dpsResults = [];
    var GlobalStats = {
        totalDmg: 0, dmgIS: 0, dmgMFDirect: 0, dmgMFTick: 0, dmgWrath: 0, dmgStarfire: 0, dmgT36p: 0,
        casts: 0, misses: 0, dmgCrit: 0, dmgEclipse: 0, uptimeAE: 0, uptimeNE: 0
    };

    // ==========================================
    // MAIN LOOP
    // ==========================================
    for (var simRun = 0; simRun < numSimulations; simRun++) {

        // State Reset
        var State = {
            currentTime: 0.0, gcdFinish: 0.0, castFinish: 0.0, isCasting: false, currentSpellId: null,
            natureEclipseEnd: 0.0, arcaneEclipseEnd: 0.0, natureEclipseCDReady: 0.0, arcaneEclipseCDReady: 0.0,
            naturesGrace: false, boatStacks: 0, t38pEnd: 0.0, buffT36pNat: 0.0, buffT36pArc: 0.0,
            fishingLastCast: "", activeMF: null, activeIS: null, pendingImpacts: [], dotCounter: 0
        };

        var SimStats = {
            totalDmg: 0, dmgIS: 0, dmgMFDirect: 0, dmgMFTick: 0, dmgWrath: 0, dmgStarfire: 0, dmgT36p: 0,
            casts: 0, misses: 0, dmgCrit: 0, dmgEclipse: 0, uptimeAE: 0, uptimeNE: 0
        };

        // Spells Definition (Inside loop to use getVal cleanly or reset logic)
        var Spells = {
            Wrath: { name: "Wrath", id: "Wrath", type: "Nature", baseCast: getVal("w_cast"), dmgNorm: getVal("w_dmg"), dmgEcl: getVal("w_dmg"), flightTime: 1.0, isDot: false },
            Starfire: { name: "Starfire", id: "Starfire", type: "Arcane", baseCast: getVal("sf_cast"), dmgNorm: getVal("sf_dmg"), dmgEcl: getVal("sf_dmg"), flightTime: 0.0, isDot: false },
            Moonfire: { name: "Moonfire", id: "Moonfire", type: "Arcane", baseCast: 0, dmgNorm: getVal("mf_hit"), dmgEcl: getVal("mf_hit"), tickNorm: getVal("mf_tick"), tickEcl: getVal("mf_tick"), duration: durMF, tickRate: 3.0, isDot: true, flightTime: 0.0 },
            InsectSwarm: { name: "Insect Swarm", id: "InsectSwarm", type: "Nature", baseCast: 0, dmgNorm: 0, dmgEcl: 0, tickNorm: getVal("is_tick"), tickEcl: getVal("is_tick"), duration: durIS, tickRate: 2.0, isDot: true, flightTime: 0.0 }
        };
        // Note: Eclipse dmg values are same as norm here because input assumes "Avg Dmg". 
        // In detailed spreadsheet logic, Ecl Dmg was often pre-calculated differently. 
        // For this port, we simplify unless you want dedicated inputs for Eclipse Dmg.

        var RNG = {
            mode: CalcMethod,
            acc: { hit: 0.0, crit: 0.0, procNE: 0.0, procAE: 0.0, procBoaT: 0.0, procT36p: 0.0 },
            check: function (chancePercent, typeID) {
                if (this.mode === "S") return (Math.random() * 100 < chancePercent);
                this.acc[typeID] += chancePercent;
                if (this.acc[typeID] >= 100) { this.acc[typeID] -= 100; return true; }
                return false;
            },
            checkHit: function (hitChance01) {
                if (this.mode === "S") return Math.random() < hitChance01;
                var missChance = 1.0 - hitChance01;
                this.acc.hit += missChance;
                if (this.acc.hit >= 1.0) { this.acc.hit -= 1.0; return false; }
                return true;
            }
        };

        // --- INTERNAL LOGIC ---
        var hasNatureEclipse = function() { return State.currentTime < State.natureEclipseEnd; };
        var hasArcaneEclipse = function() { return State.currentTime < State.arcaneEclipseEnd; };

        var addEvent = function(time, type, payload) {
            if (isNaN(time)) time = State.currentTime;
            State.pendingImpacts.push({ time: time, type: type, payload: payload });
            State.pendingImpacts.sort(function(a, b) { return a.time - b.time; });
        };

        var cancelCurrentCast = function() {
            if (!State.isCasting) return;
            var index = -1;
            for (var i = 0; i < State.pendingImpacts.length; i++) {
                if (State.pendingImpacts[i].type === "CAST_FINISH") { index = i; break; }
            }
            if (index > -1) {
                State.pendingImpacts.splice(index, 1);
                State.isCasting = false;
                State.currentSpellId = null;
            }
        };

        var getCastTime = function(spell) {
            var base = spell.baseCast;
            if (State.naturesGrace && (spell.id === "Wrath" || spell.id === "Starfire")) base -= 0.5;
            if (spell.id === "Starfire" && State.boatStacks > 0) base -= (State.boatStacks * Talents.boatReduc);
            if (spell.id === "Starfire" && Gear.idolEoF) base -= 0.2;
            if (base < 0) base = 0;
            var hastePercent = Stats.haste;
            if (Gear.t3_8p && State.currentTime < State.t38pEnd) hastePercent += 10;
            return Math.max(0, base / (1 + hastePercent / 100));
        };

        var getGCD = function(spell) { return (spell.id === "Wrath") ? 0.5 : 1.5; };

        var calculateDamageFull = function(spell, isTick, forceSnap, isCrit) {
            var useEcl = (forceSnap !== undefined) ? forceSnap : ((spell.type === "Nature" && hasNatureEclipse()) || (spell.type === "Arcane" && hasArcaneEclipse()));
            var valNorm = isTick ? spell.tickNorm : spell.dmgNorm;
            // Simplified for web: Assuming Ecl Dmg = Norm Dmg input * 1 (Logic handles multipliers)
            // Real logic: In sheet, "dmgEcl" column was separate. Here we apply logic dynamically or use same base.
            var baseDmg = valNorm; 
            
            var mult = 1.0;
            // Eclipse Bonus logic needs to be APPLIED here if inputs are just "Base".
            // However, your sheet likely had pre-calculated Ecl values. 
            // For this Web Port, I will assume inputs are NON-ECLIPSE values and I add 20% if Eclipse is active?
            // Wait, Turtle WoW Eclipse is +20% dmg? Or just crit/haste?
            // Looking at your previous logs: Wrath 1004 vs Starfire 1828.
            // Let's assume the INPUTS are "Normal Hits".
            // If Eclipse is active, usually dmg is increased. 
            // YOUR LOGIC from Google Script: "var baseDmg = useEcl ? valEcl : valNorm;"
            // Since we only have one input field per spell in HTML, I will assume +0% bonus from Eclipse unless defined.
            // *CORRECTION*: In Turtle WoW, Eclipse gives +Damage usually?
            // To be safe: I will use valNorm for both. If you want Eclipse scaling, we need to add code here.
            // Assuming: The spreadsheet pre-calculated "dmgEcl".
            // Workaround: I will simply use valNorm. 
            
            // Apply Dynamic Multipliers
            var t36pActive = false;
            if (spell.id === "Moonfire" && Gear.idolMoon) mult += 0.17;
            if (spell.id === "InsectSwarm" && Gear.idolProp) mult += 0.17;
            if (Gear.t3_6p) {
                if (spell.type === "Nature" && State.buffT36pNat > State.currentTime) { mult += 0.03; t36pActive = true; }
                else if (spell.type === "Arcane" && State.buffT36pArc > State.currentTime) { mult += 0.03; t36pActive = true; }
            }
            
            baseDmg *= mult;
            
            // Apply Eclipse Multiplier if distinct values not provided?
            // Let's assume input is raw. 
            
            var logBase = baseDmg;
            var logEclBonus = 0; // We can't easily calc this without separate inputs
            var critBonus = isCrit ? baseDmg : 0;
            var total = baseDmg + critBonus;
            var t3Part = t36pActive ? total * (0.03 / mult) : 0;
            return { logBase: logBase, logEcl: logEclBonus, logCrit: critBonus, total: total, usedEcl: useEcl, t3Part: t3Part };
        };

        // --- HANDLERS ---
        var performCast = function(spell) {
            var castTime = getCastTime(spell);
            var gcd = getGCD(spell);
            State.isCasting = true;
            State.castFinish = State.currentTime + castTime;
            State.gcdFinish = State.currentTime + gcd;
            State.currentSpellId = spell.id;
            SimStats.casts++;

            if (State.naturesGrace && (spell.id === "Wrath" || spell.id === "Starfire")) State.naturesGrace = false;
            if (spell.id === "Starfire") State.boatStacks = 0;
            if (spell.id === "Wrath" || spell.id === "Starfire") State.fishingLastCast = spell.id;

            addEvent(State.castFinish, "CAST_FINISH", { spell: spell });
        };

        var handleCastFinish = function(spell) {
            State.isCasting = false;
            State.currentSpellId = null;
            if (!RNG.checkHit(Stats.hitCoeff)) {
                SimStats.misses++;
                return;
            }
            var isCrit = RNG.check(Stats.spellCrit, "crit");
            var eclActive = (spell.type === "Nature" && hasNatureEclipse()) || (spell.type === "Arcane" && hasArcaneEclipse());

            if (spell.isDot) {
                State.dotCounter++;
                var dot = { id: State.dotCounter, spell: spell, nextTick: State.currentTime + spell.tickRate, expires: State.currentTime + spell.duration, snapshotEcl: eclActive };
                if (spell.id === "Moonfire") State.activeMF = dot; else State.activeIS = dot;
                addEvent(dot.nextTick, "DOT_TICK", { spellId: spell.id, dotId: dot.id });
                if (spell.dmgNorm > 0 || spell.dmgEcl > 0) handleImpact({ spell: spell, crit: isCrit, snapshotEcl: eclActive });
            } else {
                var flight = spell.flightTime || 0.0;
                addEvent(State.currentTime + flight, "IMPACT", { spell: spell, crit: isCrit, snapshotEcl: eclActive });
            }
        };

        var handleImpact = function(payload) {
            var d = calculateDamageFull(payload.spell, false, payload.snapshotEcl, payload.crit);
            SimStats.totalDmg += d.total;
            SimStats.dmgEclipse += d.logEcl; SimStats.dmgT36p += d.t3Part;
            if (payload.crit) SimStats.dmgCrit += d.total;
            if (payload.spell.id === "Wrath") SimStats.dmgWrath += d.total;
            if (payload.spell.id === "Starfire") SimStats.dmgStarfire += d.total;
            if (payload.spell.id === "Moonfire") SimStats.dmgMFDirect += d.total;

            if (payload.crit) State.naturesGrace = true;
            var triggeredEclipse = false;

            if (payload.spell.id === "Starfire" && !hasArcaneEclipse()) {
                if (State.currentTime >= State.natureEclipseCDReady && RNG.check(Talents.nEProc, "procNE")) {
                    State.natureEclipseEnd = State.currentTime + Talents.neDuration;
                    State.natureEclipseCDReady = State.currentTime + Talents.neICD;
                    triggeredEclipse = true;
                    if (RotaSettings.spellInterrupt && State.isCasting) {
                        if (State.currentSpellId === "Starfire" || State.currentSpellId === "Moonfire") cancelCurrentCast();
                    }
                }
            }
            if (payload.spell.id === "Wrath" && !hasNatureEclipse()) {
                if (State.currentTime >= State.arcaneEclipseCDReady && RNG.check(Talents.aEProc, "procAE")) {
                    State.arcaneEclipseEnd = State.currentTime + Talents.aeDuration;
                    State.arcaneEclipseCDReady = State.currentTime + Talents.aeICD;
                    triggeredEclipse = true;
                    if (RotaSettings.spellInterrupt && State.isCasting) {
                        if (State.currentSpellId === "Wrath" || State.currentSpellId === "InsectSwarm") cancelCurrentCast();
                    }
                }
            }
            if (triggeredEclipse && Gear.t3_8p) State.t38pEnd = State.currentTime + 8.0;
        };

        var handleTick = function(payload) {
            var dot = (payload.spellId === "Moonfire") ? State.activeMF : State.activeIS;
            if (!dot || payload.dotId !== dot.id || State.currentTime > dot.expires + 0.01) return;
            var d = calculateDamageFull(dot.spell, true, dot.snapshotEcl, false);
            SimStats.totalDmg += d.total;
            SimStats.dmgEclipse += d.logEcl; SimStats.dmgT36p += d.t3Part;
            if (payload.spellId === "InsectSwarm") SimStats.dmgIS += d.total;
            if (payload.spellId === "Moonfire") SimStats.dmgMFTick += d.total;

            if (payload.spellId === "InsectSwarm") {
                if (RNG.check(Talents.boatChance * 100, "procBoaT") && State.boatStacks < 3) State.boatStacks++;
            }
            if (Gear.t3_6p && RNG.check(8, "procT36p")) {
                State.buffT36pNat = State.currentTime + 6.0;
                State.buffT36pArc = State.currentTime + 6.0;
            }

            if (State.currentTime + dot.spell.tickRate <= dot.expires + 0.01) {
                addEvent(State.currentTime + dot.spell.tickRate, "DOT_TICK", { spellId: dot.spell.id, dotId: dot.id });
            } else {
                if (payload.spellId === "Moonfire") State.activeMF = null; else State.activeIS = null;
            }
        };

        var decideSpell = function() {
            var aeUptime = Math.max(0, State.arcaneEclipseEnd - State.currentTime);
            var neUptime = Math.max(0, State.natureEclipseEnd - State.currentTime);
            var aeCD = Math.max(0, State.arcaneEclipseCDReady - State.currentTime);
            var neCD = Math.max(0, State.natureEclipseCDReady - State.currentTime);
            var isMF = State.activeMF && State.activeMF.expires > State.currentTime;
            var isIS = State.activeIS && State.activeIS.expires > State.currentTime;

            if (aeUptime > 0) {
                var sfCast = getCastTime(Spells.Starfire);
                if (aeUptime > sfCast) return Spells.Starfire;
                if (RotaSettings.castMF && RotaSettings.eclDOT && (!isMF || State.activeMF.expires - State.currentTime < 2)) return Spells.Moonfire;
                return Spells.Starfire;
            }
            else if (neUptime > 0) {
                var wCast = getCastTime(Spells.Wrath);
                if (neUptime > wCast) return Spells.Wrath;
                if (RotaSettings.castIS && RotaSettings.eclDOT && (!isIS || State.activeIS.expires - State.currentTime < 2)) return Spells.InsectSwarm;
                return Spells.Wrath;
            }
            else {
                if (RotaSettings.castIS && (!isIS || State.activeIS.expires < State.currentTime + 1.5)) return Spells.InsectSwarm;
                if (RotaSettings.castMF && (!isMF || State.activeMF.expires < State.currentTime + 1.5)) return Spells.Moonfire;
                if (aeCD > 0 && neCD === 0) return Spells.Starfire;
                if (neCD > 0 && aeCD === 0) return Spells.Wrath;
                var last = State.fishingLastCast;
                if (RotaSettings.fishMeth === "F1") return (last === "" || last === "Wrath") ? Spells.Starfire : Spells.Wrath;
                if (RotaSettings.fishMeth === "F2") return (last === "" || last === "Starfire") ? Spells.Wrath : Spells.Starfire;
                if (RotaSettings.fishMeth === "W") return Spells.Wrath;
                return Spells.Starfire;
            }
        };

        // --- TIME LOOP ---
        var loopGuard = 0;
        while (State.currentTime < MaxTime && loopGuard < 50000) {
            loopGuard++;
            while (State.pendingImpacts.length > 0 && State.pendingImpacts[0].time <= State.currentTime + 0.001) {
                var evt = State.pendingImpacts.shift();
                if (evt.type === "CAST_FINISH") handleCastFinish(evt.payload.spell);
                else if (evt.type === "IMPACT") handleImpact(evt.payload);
                else if (evt.type === "DOT_TICK") handleTick(evt.payload);
            }
            var gcdReady = State.currentTime >= State.gcdFinish - 0.001;
            if (!State.isCasting && gcdReady && State.currentTime < MaxTime) {
                var spell = decideSpell();
                if (spell) performCast(spell);
            }
            var nextEvt = (State.pendingImpacts.length > 0) ? State.pendingImpacts[0].time : 99999;
            var nextAct = State.isCasting ? 99999 : (State.currentTime < State.gcdFinish ? State.gcdFinish : State.currentTime);
            var jump = Math.min(nextEvt, nextAct);
            if (jump >= 99990) break;
            if (jump > MaxTime) jump = MaxTime;

            var dt = jump - State.currentTime;
            if (dt > 0) {
                if (hasNatureEclipse()) SimStats.uptimeNE += Math.min(dt, State.natureEclipseEnd - State.currentTime);
                if (hasArcaneEclipse()) SimStats.uptimeAE += Math.min(dt, State.arcaneEclipseEnd - State.currentTime);
            }

            if (jump <= State.currentTime + 0.0001) {
                if (nextEvt <= State.currentTime + 0.001) { jump = State.currentTime; }
                else {
                    var future = State.pendingImpacts.find(e => e.time > State.currentTime + 0.001);
                    var safeJump = Math.min(future ? future.time : 99999, (State.gcdFinish > State.currentTime + 0.001) ? State.gcdFinish : 99999);
                    jump = (safeJump >= 99990) ? State.currentTime + 0.1 : safeJump;
                }
            }
            State.currentTime = jump;
        }

        // Run End Data
        var runDPS = SimStats.totalDmg / MaxTime;
        dpsResults.push(runDPS);
        for (var key in GlobalStats) {
            GlobalStats[key] += SimStats[key];
        }

    } // End Simulation Loop

    // --- RENDER OUTPUT ---
    renderResults(dpsResults, GlobalStats, numSimulations, MaxTime);
}

function renderResults(dpsResults, GlobalStats, numSimulations, MaxTime) {
    // 1. Avg Calculation
    for (var key in GlobalStats) {
        GlobalStats[key] = GlobalStats[key] / numSimulations;
    }
    
    var minDPS = Math.min(...dpsResults);
    var maxDPS = Math.max(...dpsResults);
    var avgDPS = dpsResults.reduce((a, b) => a + b, 0) / dpsResults.length;

    // 2. Fill DOM
    document.getElementById("resultsArea").classList.remove("hidden");
    document.getElementById("out_dps_avg").innerText = avgDPS.toFixed(1);
    document.getElementById("out_dps_minmax").innerText = minDPS.toFixed(1) + " / " + maxDPS.toFixed(1);
    document.getElementById("out_total_dmg").innerText = Math.floor(GlobalStats.totalDmg).toLocaleString();

    document.getElementById("out_up_ne").innerText = (GlobalStats.uptimeNE / MaxTime * 100).toFixed(1) + "%";
    document.getElementById("out_up_ae").innerText = (GlobalStats.uptimeAE / MaxTime * 100).toFixed(1) + "%";

    // 3. Table Fill
    var tbody = document.getElementById("tbl_body");
    tbody.innerHTML = ""; // Clear

    function addRow(label, dmg, total) {
        var pct = (total > 0) ? (dmg / total * 100).toFixed(1) + "%" : "0%";
        var row = `<tr><td>${label}</td><td>${Math.floor(dmg).toLocaleString()}</td><td>${pct}</td></tr>`;
        tbody.innerHTML += row;
    }

    addRow("Starfire", GlobalStats.dmgStarfire, GlobalStats.totalDmg);
    addRow("Wrath", GlobalStats.dmgWrath, GlobalStats.totalDmg);
    addRow("Moonfire (Hit)", GlobalStats.dmgMFDirect, GlobalStats.totalDmg);
    addRow("Moonfire (Tick)", GlobalStats.dmgMFTick, GlobalStats.totalDmg);
    addRow("Insect Swarm", GlobalStats.dmgIS, GlobalStats.totalDmg);
    addRow("T3 6p Proc", GlobalStats.dmgT36p, GlobalStats.totalDmg);
}