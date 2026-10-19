// Child processes that must not outlive the app (the RDP helper). They are
// put in one job object whose handle only this process holds: when the app
// exits in any way, including a crash or Task Manager, Windows closes the
// handle and ends every process still in the job.

use std::os::windows::io::AsRawHandle;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

struct Job(HANDLE);
// The handle is only used for AssignProcessToJobObject, which is thread-safe.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

fn job() -> Option<&'static Job> {
    static JOB: OnceLock<Option<Job>> = OnceLock::new();
    JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        (ok != 0).then_some(Job(h))
    })
    .as_ref()
}

/// Tie `child` to the app's lifetime. Best effort: when the job cannot be
/// set up the child still runs and is stopped by the usual close path.
pub fn adopt(child: &std::process::Child) {
    if let Some(job) = job() {
        unsafe {
            AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_adopted_child_is_in_the_job() {
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        let mut child = std::process::Command::new(r"C:\Windows\System32\cmd.exe")
            .args(["/c", "ping -n 3 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        super::adopt(&child);
        let mut inside = 0;
        unsafe {
            use std::os::windows::io::AsRawHandle;
            IsProcessInJob(child.as_raw_handle() as _, super::job().unwrap().0, &mut inside);
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_ne!(inside, 0);
    }
}
