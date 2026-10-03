import Foundation

/// Pure 4-state FSM for island open/close logic.
/// No AppKit / AppState dependencies — communicates via `onTransition`.
@MainActor
final class IslandStateMachine {

    enum State: Equatable {
        case hidden   // island invisible (notch size)
        case petit    // compact island (notch + ears)
        case home     // expanded, overview
        case coucou   // expanded, greeting animation
    }

    private(set) var state: State = .hidden

    /// Fired on every transition: (from, to)
    var onTransition: ((State, State) -> Void)?

    /// When non-nil and returns true, timers and mouse-leave never auto-collapse or hide the island.
    var isHeldOpen: (() -> Bool)?

    /// True while at least one agent is working. While this holds, the island
    /// auto-expands and no auto-close timer runs: an island showing live work
    /// must not fold under the user. Driven by `AppState.hasActiveWork`.
    var isBusy: (() -> Bool)?

    /// home → petit delay (seconds). Bound to `AppState.autoCloseInterval` by
    /// the window controller; the default is only a fallback for tests.
    var homeToPetitDelay: TimeInterval = 15
    /// petit → hidden delay (seconds). Override for debug.
    var petitToHiddenDelay: TimeInterval = 60
    /// coucou → petit delay after greeting animation ends (no hover). ~0.6s syncs with canvas collapse.
    var greetAutoCollapseDelay: TimeInterval = 0.6
    /// coucou → petit delay when mouse is hovering over the greeting.
    var greetHoverCollapseDelay: TimeInterval = 10
    /// hidden → home after this long hovering the notch (SPEC: peek then expand).
    var peekExpandDelay: TimeInterval = 0.65
    /// petit → home after this long hovering the compact island (SPEC:4).
    var compactExpandDelay: TimeInterval = 0.2
    /// Hard ceiling on how long live work may hold the island open. A `Stop` that
    /// never arrives (crashed agent, killed terminal) would otherwise keep the
    /// card expanded indefinitely, so the ceiling wins over `isBusy`.
    var busyMaxHold: TimeInterval = 600

    private var petitHideWork: DispatchWorkItem?
    private var homeCollapseWork: DispatchWorkItem?
    private var greetCollapseWork: DispatchWorkItem?
    private var dwellExpandWork: DispatchWorkItem?
    private var busySince: Date?

    // MARK: – Inputs

    /// App launched or debug "launch greeting"
    func launch() {
        cancelTimers()
        transition(to: .coucou)
    }

    /// Mouse entered the island notch area
    func mouseEntered() {
        switch state {
        case .hidden:
            if isHeldOpen?() == true {
                // Island already expanded by an external call — sync FSM state without transition
                state = .home
            } else if isBusy?() == true {
                // Work in progress: go straight to the expanded card, no peek.
                cancelTimers()
                transition(to: .home)
            } else {
                cancelTimers()
                transition(to: .petit)
                scheduleDwellExpand(after: peekExpandDelay)
            }
        case .petit:
            petitHideWork?.cancel()
            petitHideWork = nil
            // Hovering the compact island opens it (SPEC:4). Skipped while the
            // island is held open by an alert, which is already expanded.
            if isHeldOpen?() != true { scheduleDwellExpand(after: compactExpandDelay) }
        case .home:
            // Interaction resets the auto-close clock.
            resetActivity()
        case .coucou:
            // Mouse hovering during greeting — cancel short auto-collapse, extend to hover delay
            scheduleGreetCollapse(delay: greetHoverCollapseDelay)
        }
    }

    /// Mouse left the island notch area
    func mouseLeft() {
        dwellExpandWork?.cancel(); dwellExpandWork = nil
        switch state {
        case .hidden:
            break
        case .petit:
            schedulePetitHide()
        case .home:
            // Leaving does not close the island, but the auto-close clock keeps
            // running: it was armed when `.home` was entered, not here.
            scheduleHomeCollapse()
        case .coucou:
            if isHeldOpen?() != true {
                // Interrupt greeting immediately → compact (overrides 10s auto-collapse)
                greetCollapseWork?.cancel(); greetCollapseWork = nil
                transition(to: .petit)
            }
        }
    }

    /// Any interaction with the open island: mouse move, click or keypress.
    /// Restarts the auto-close countdown.
    func resetActivity() {
        guard state == .home else { return }
        scheduleHomeCollapse()
    }

    /// Starts (or restarts) the auto-close clock for the expanded island.
    /// Called when `.home` is entered, hover or not: the island folds after the
    /// configured delay of inactivity whether or not the cursor is on it.
    func armAutoCollapse() {
        guard state == .home else { return }
        scheduleHomeCollapse()
    }

    /// Work state changed (an agent started or went idle). Expands on work,
    /// and re-evaluates the collapse timer when everything goes quiet.
    func busyStateChanged() {
        if isBusy?() == true {
            // Stamped on the busy edge only: a task churning between `working`
            // and `thinking` must not keep resetting the ceiling.
            if busySince == nil { busySince = .now }
            guard state == .hidden || state == .petit else {
                scheduleHomeCollapse()   // re-arm the bounded busy hold
                return
            }
            cancelTimers()
            transition(to: .home)
        } else {
            busySince = nil
            if state == .home { scheduleHomeCollapse() }
        }
    }

    /// Compact island clicked.
    /// Also accepts `.hidden`: after an alert the island can be on screen while the
    /// FSM never saw the mouse enter (it was already there), and the click must still open it.
    func click() {
        guard state == .petit || state == .hidden else { return }
        cancelTimers()
        transition(to: .home)
    }

    /// The app hid the island on its own (e.g. `AppState.syncMode()` when the last
    /// task ends). Mirror it without side effects, so the next hover peeks again
    /// instead of being swallowed by a FSM that still thinks the island is `.petit`.
    func hiddenExternally() {
        guard state == .petit else { return }
        cancelTimers()
        state = .hidden
    }

    /// The app expanded the island externally (hookExpand for an alert).
    /// Cancel timers and sync state to `.home` without firing `onTransition`, so the
    /// next hover/mouseLeft behave correctly instead of collapsing the island.
    func openedExternally() {
        cancelTimers()
        guard state != .home && state != .coucou else { return }
        state = .home
    }

    /// The app folded the island itself (Escape, Settings, OK button, auto-close).
    /// Move to `.petit` right away so hover and click keep working; waiting for the
    /// 15 s home timer left the island compact on screen while the FSM still said `.home`.
    func collapse() {
        guard state == .home || state == .coucou else { return }
        cancelTimers()
        transition(to: .petit)
    }

    /// Greeting animation finished (called at T.end ≈ 4.60 s).
    /// Schedules auto-collapse. Does not override a longer hover timer already running.
    func greetComplete() {
        guard state == .coucou else { return }
        // If mouse entered before this fires (hover timer already running), don't override it
        if greetCollapseWork == nil {
            scheduleGreetCollapse(delay: greetAutoCollapseDelay)
        }
    }

    private func scheduleGreetCollapse(delay: TimeInterval) {
        greetCollapseWork?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.state == .coucou else { return }
            self.transition(to: .petit)
        }
        greetCollapseWork = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// Non-alert work event: show compact from hidden (HookServer reveal)
    func reveal() {
        guard state == .hidden else { return }
        cancelTimers()
        // Work in progress deserves the full card, not the compact strip.
        if isBusy?() == true {
            transition(to: .home)
        } else {
            transition(to: .petit)
            schedulePetitHide()
        }
    }

    // MARK: – Timers

    private func schedulePetitHide() {
        petitHideWork?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.state == .petit, !(self.isHeldOpen?() ?? false) else { return }
            self.transition(to: .hidden)
        }
        petitHideWork = item
        DispatchQueue.main.asyncAfter(deadline: .now() + petitToHiddenDelay, execute: item)
    }

    private func scheduleHomeCollapse() {
        homeCollapseWork?.cancel(); homeCollapseWork = nil
        // A pending alert holds the island open unconditionally.
        guard isHeldOpen?() != true else { return }

        let delay: TimeInterval
        if isBusy?() == true {
            // Live work holds it too, but only up to busyMaxHold: a `Stop` that
            // never arrives (crashed agent, killed terminal) would otherwise keep
            // the card expanded forever.
            let held = busySince.map { Date.now.timeIntervalSince($0) } ?? 0
            delay = max(0, busyMaxHold - held)
            guard delay > 0 else { return }
        } else {
            delay = homeToPetitDelay
        }

        let item = DispatchWorkItem { [weak self] in
            guard let self, self.state == .home, self.isHeldOpen?() != true else { return }
            // The busy hold expires on wall-clock, not on "the work item happened
            // to be early": a callback that runs a moment early must re-arm for
            // the remainder instead of returning and leaving the island open.
            if self.isBusy?() == true {
                let since = self.busySince ?? .now
                let left = self.busyMaxHold - Date.now.timeIntervalSince(since)
                if left > 0 { self.scheduleHomeCollapse(); return }
            }
            self.transition(to: .petit)
        }
        homeCollapseWork = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// Hover long enough on the peek or the compact island and it expands by itself.
    private func scheduleDwellExpand(after delay: TimeInterval) {
        dwellExpandWork?.cancel()
        let from = state
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.state == from else { return }
            self.dwellExpandWork = nil
            // A live task expands immediately on hover; the dwell only covers
            // the idle case, where an accidental brush past must not open it.
            guard self.isHeldOpen?() != true else { return }
            self.cancelTimers()
            self.transition(to: .home)
        }
        dwellExpandWork = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    func cancelTimers() {
        petitHideWork?.cancel();    petitHideWork = nil
        homeCollapseWork?.cancel(); homeCollapseWork = nil
        greetCollapseWork?.cancel(); greetCollapseWork = nil
        dwellExpandWork?.cancel();   dwellExpandWork = nil
    }

    private func transition(to new: State) {
        guard new != state else { return }
        let old = state
        state = new
        onTransition?(old, new)
        // Entering the expanded state always (re)starts the auto-close clock, so
        // no route into `.home` can leave the island open forever. `onTransition`
        // runs first: it is what actually puts the island on screen, and arming
        // must be the last thing that happens.
        if new == .home { scheduleHomeCollapse() }
    }

}
