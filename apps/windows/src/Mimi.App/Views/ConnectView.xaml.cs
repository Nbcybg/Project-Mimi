using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Mimi.Core.Desktop;
using Mimi.Core.ViewModels;
using Windows.System;

namespace Mimi.App.Views;

public sealed partial class ConnectView : UserControl, INotifyPropertyChanged
{
    public ConnectView(ConnectViewModel viewModel, Func<Task<LocalCoreReady>>? startLocal = null)
    {
        ViewModel = viewModel;
        InitializeComponent();
        var local = LocalButton(startLocal);
        viewModel.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(ConnectViewModel.Step)) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(SignInVisible)));
            if (local is not null && args.PropertyName is nameof(ConnectViewModel.Step) or nameof(ConnectViewModel.CanUseLocal) or nameof(ConnectViewModel.Busy)) Paint(local);
        };
    }

    /// <summary>"ใช้เซิร์ฟเวอร์ในเครื่องนี้" under the address box: the app starts the core here and signs in to it.</summary>
    private StackPanel? LocalButton(Func<Task<LocalCoreReady>>? startLocal)
    {
        if (startLocal is null || ServerBox.Parent is not StackPanel step) return null;
        var box = new StackPanel { Spacing = 6, Margin = new Thickness(0, 6, 0, 0) };
        box.Children.Add(new TextBlock { Text = "หรือ", HorizontalAlignment = HorizontalAlignment.Center, Style = (Style)Application.Current.Resources["MimiCaption"] });
        var button = new Button { Content = "ใช้เซิร์ฟเวอร์ในเครื่องนี้", HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetAutomationId(button, "LocalServerButton");
        button.Click += (_, _) => _ = ViewModel.UseLocal(startLocal);
        box.Children.Add(button);
        box.Children.Add(new TextBlock
        {
            Text = "แอปเปิด Mimi core บนคอมพิวเตอร์นี้ให้เอง (ข้อมูลอยู่ที่ เอกสาร\\Mimi) และเปิดทุกครั้งที่เปิดแอป — ใช้ได้คนเดียวบนเครื่องนี้",
            TextWrapping = TextWrapping.Wrap,
            Style = (Style)Application.Current.Resources["MimiCaption"],
        });
        step.Children.Add(box);
        Paint(box);
        return box;
    }

    private void Paint(StackPanel local)
    {
        local.Visibility = ViewModel.CanUseLocal && ViewModel.OnServer ? Visibility.Visible : Visibility.Collapsed;
        foreach (var button in local.Children.OfType<Button>()) button.IsEnabled = ViewModel.Idle;
    }

    public ConnectViewModel ViewModel { get; }

    public bool SignInVisible => !ViewModel.OnServer;

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnServerKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && ViewModel.Idle) _ = ViewModel.Check();
    }

    private void OnSignInKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && ViewModel.Idle) _ = ViewModel.SignIn();
    }
}
