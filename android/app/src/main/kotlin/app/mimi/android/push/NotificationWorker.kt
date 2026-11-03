package app.mimi.android.push

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.mimi.android.Notifier
import app.mimi.android.widget.WidgetSync
import app.mimi.core.data.repo.PushRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

/**
 * Asks the core for new notifications and posts them natively. The path when there is no FCM
 * push (a build without Firebase ids, or a core without the key), and the catch-up after a
 * push arrives: every ~15 minutes, the shortest Android allows (push-and-background.md 5).
 */
@HiltWorker
class NotificationWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val push: PushRepository,
    private val widget: WidgetSync,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        runCatching { push.newNotifications().forEach { Notifier.show(applicationContext, it) } }
        runCatching { widget.refresh() }
        return Result.success()
    }

    companion object {
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "mimi-notifications",
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<NotificationWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
            )
        }

        fun now(context: Context) {
            WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<NotificationWorker>().setConstraints(online).build())
        }

        fun cancel(context: Context) = WorkManager.getInstance(context).cancelUniqueWork("mimi-notifications")
    }
}
