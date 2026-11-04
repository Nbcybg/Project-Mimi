package app.mimi.feature.auth

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.mimi.core.ui.MimiColors

@Composable
fun AuthRoute(onSignedIn: () -> Unit, viewModel: AuthViewModel = hiltViewModel()) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    LaunchedEffect(ui.signedIn) { if (ui.signedIn) onSignedIn() }
    AuthContent(
        ui = ui,
        onServer = viewModel::setServer,
        onConnect = viewModel::connect,
        onRemember = viewModel::setRemember,
        onBack = viewModel::back,
        onSignIn = viewModel::signIn,
    )
}

/** Stateless, so the Compose test drives it directly. */
@Composable
fun AuthContent(
    ui: AuthUiState,
    onServer: (String) -> Unit,
    onConnect: () -> Unit,
    onRemember: (Boolean) -> Unit,
    onBack: () -> Unit,
    onSignIn: (username: String, password: String, code: String) -> Unit,
) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // The web's sign-in card (app.css): a panel with a hairline border and rounded corners.
            Column(
                Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MimiColors.panel)
                    .border(1.dp, MimiColors.line, RoundedCornerShape(16.dp)).padding(22.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(if (ui.step == AuthStep.Server || !ui.accounts) "เชื่อมต่อ Mimi" else "เข้าสู่ระบบ Mimi", fontSize = 17.sp, fontWeight = FontWeight.Bold)
                when (ui.step) {
                    AuthStep.Server -> {
                        Text("ที่อยู่เซิร์ฟเวอร์ Mimi ของคุณ (core หรือ gateway)", color = MimiColors.muted, fontSize = 14.sp)
                        OutlinedTextField(
                            value = ui.server,
                            onValueChange = onServer,
                            label = { Text("เซิร์ฟเวอร์") },
                            placeholder = { Text("mimi.example.com") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                            modifier = Modifier.fillMaxWidth().testTag("server"),
                            shape = FieldShape,
                            colors = fieldColors(),
                        )
                        if (ui.appTooOld) {
                            Text("เซิร์ฟเวอร์นี้ต้องใช้แอป Mimi เวอร์ชันใหม่กว่านี้ — กรุณาอัปเดตแอป", color = MimiColors.bad, modifier = Modifier.testTag("tooOld"))
                        }
                        Button(onClick = onConnect, enabled = !ui.busy && ui.server.isNotBlank(), shape = FieldShape, modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp).testTag("connect")) {
                            Text("ถัดไป", fontWeight = FontWeight.SemiBold)
                        }
                    }
                    AuthStep.Credentials -> {
                        Text(
                            if (ui.accounts) "ใช้ชื่อผู้ใช้และรหัสผ่านที่ผู้ดูแลสร้างให้" else "ใส่รหัสผ่านของ Mimi (MIMI_TOKEN ของเซิร์ฟเวอร์)",
                            color = MimiColors.muted,
                            fontSize = 14.sp,
                        )
                        Text("${ui.server}${if (ui.coreVersion.isNotEmpty()) " · ${ui.coreVersion}" else ""}", color = MimiColors.faint, style = MaterialTheme.typography.bodySmall)
                        if (ui.accounts) {
                            OutlinedTextField(username, { username = it }, label = { Text("ชื่อผู้ใช้") }, singleLine = true, shape = FieldShape, colors = fieldColors(), modifier = Modifier.fillMaxWidth().testTag("username"))
                        }
                        OutlinedTextField(
                            password,
                            { password = it },
                            label = { Text(if (ui.accounts) "รหัสผ่าน" else "รหัสผ่านของ Mimi") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            shape = FieldShape,
                            colors = fieldColors(),
                            modifier = Modifier.fillMaxWidth().testTag("password"),
                        )
                        if (ui.askCode) {
                            OutlinedTextField(
                                code,
                                { code = it },
                                label = { Text("รหัส 6 หลักจากแอปยืนยันตัวตน") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                shape = FieldShape,
                                colors = fieldColors(),
                                modifier = Modifier.fillMaxWidth().testTag("code"),
                            )
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = !ui.remember, onCheckedChange = { onRemember(!it) }, modifier = Modifier.testTag("notMine"))
                            Text("เครื่องนี้ไม่ใช่ของฉัน (ไม่จำการเข้าสู่ระบบ)", color = MimiColors.ink2, fontSize = 13.sp)
                        }
                        Button(
                            onClick = { onSignIn(username, password, code) },
                            enabled = !ui.busy && password.isNotEmpty() && (!ui.accounts || username.isNotBlank()),
                            shape = FieldShape,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 46.dp).testTag("signIn"),
                        ) { Text("เข้าสู่ระบบ", fontWeight = FontWeight.SemiBold) }
                        TextButton(onClick = onBack) { Text("เปลี่ยนเซิร์ฟเวอร์") }
                    }
                }
                if (ui.busy) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                ui.error?.let { Text(it, color = MimiColors.bad, modifier = Modifier.testTag("error")) }
            }
        }
    }
}

private val FieldShape = RoundedCornerShape(10.dp)

/** The web's inputs (app.css): a darker well with a hairline border, accent when focused. */
@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedContainerColor = MimiColors.codeBg,
    unfocusedContainerColor = MimiColors.codeBg,
    focusedBorderColor = MimiColors.accent.copy(alpha = 0.6f),
    unfocusedBorderColor = MimiColors.line,
)
